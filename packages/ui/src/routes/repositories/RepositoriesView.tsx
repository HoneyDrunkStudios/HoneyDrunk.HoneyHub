import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactElement, RefObject, SetStateAction } from "react";
import type {
  BridgeEvent,
  ContentMatch,
  ContentSearchResults,
  DirListing,
  FileContents,
  GitBranches,
  GitDiff,
  GitFileStatus,
  GitFileVersions,
  GitOpResult,
  GitOverview,
  GitStatus,
  SearchResults
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { basename, isWithin } from "../../paths";
import { resolveDefaultWorkspaceRoot } from "../../settingsModel";
import { diffStat, groupFiles, replaceRepoStatus, toDiffLines } from "../git/gitModel";
import { isMarkdownFile, renderMarkdown } from "../browse/fileView";
import { fileIcon, folderIcon } from "./fileIcons";
import EditorTabs from "./EditorTabs";

// Monaco is heavy, so the file editor is loaded only once a file is opened. The base bundle
// (and the mobile PWA that never touches a file) stays light; a <Suspense> fallback covers the
// one-time chunk fetch.
const CodeEditor = lazy(() => import("./CodeEditor"));
// The Monaco side-by-side diff is likewise lazy — only fetched once a changed file's diff is
// opened, so the base bundle stays light.
const DiffViewer = lazy(() => import("./DiffViewer"));

/**
 * One open file in the editor tab strip. The editor holds several files at once (VS Code model):
 * each tab carries its own on-disk `file`, live `draft`, and load/save status, so switching tabs
 * never loses an edit. `activeFilePath` (in the component) selects which tab's editor shows.
 */
interface OpenFile {
  /** The file's absolute path (the tab's identity). */
  path: string;
  /** The on-disk contents (undefined while the first read is in flight). */
  file: FileContents | undefined;
  /** The live editor text, seeded from disk and compared against it to derive the dirty dot. */
  draft: string;
  /** True while the initial read is in flight. */
  loading: boolean;
  /** A read error for this tab, if the file couldn't be opened. */
  error: string | undefined;
  /** True while a save is in flight. */
  saving: boolean;
  /** A save error for this tab, if the last write failed. */
  saveError: string | undefined;
}

/** A freshly opened (still loading) tab for `path`. */
function newOpenFile(path: string): OpenFile {
  return { path, file: undefined, draft: "", loading: true, error: undefined, saving: false, saveError: undefined };
}

/** Unsaved edits: a non-truncated open file whose editor text has diverged from disk. */
function isDirtyTab(tab: OpenFile): boolean {
  return tab.file !== undefined && !tab.file.truncated && tab.draft !== tab.file.content;
}

/** Apply a partial patch to the open file at `path` (a no-op if that tab isn't open). */
function patchOpenFile(
  setOpenFiles: Dispatch<SetStateAction<OpenFile[]>>,
  path: string,
  patch: Partial<OpenFile>
): void {
  setOpenFiles((prev) => prev.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
}

export interface RepositoriesViewProps {
  client: WireClient;
  active: boolean;
  /** Allowlisted workspace roots (folders or single repos) to pick from. */
  workspaceRoots: string[];
  /** The user's default workspace, pre-selected here. */
  defaultWorkspaceRoot?: string;
  /** A repo to open on entry (e.g. the Hub's "Changes in progress" list hands one over): switches
      the folder to its owning workspace root and focuses Source Control on it. One-shot — the
      parent clears it via {@link onSelectedRepoConsumed} once honored, so a later manual repo pick
      is not overridden on every render. */
  selectedRepo?: string;
  /** Called once {@link selectedRepo} has been honored, so the parent can drop the target. */
  onSelectedRepoConsumed?: () => void;
}

interface PendingConfirm {
  message: string;
  action: () => void;
}

interface ContextTarget {
  x: number;
  y: number;
  repoRoot: string;
  file: GitFileStatus;
  staged: boolean;
}

/** Join a child name onto a parent path, honoring the separator the parent implies. */
function childPath(parent: string, name: string): string {
  if (parent.length === 0) {
    return name;
  }
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/** A caught rejection's message, or a fallback for non-Error throws. */
function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** The tree-row caret glyph: collapsed/expanded for a directory, a dot for a file. */
function caretGlyph(isDir: boolean, isOpen: boolean): string {
  if (!isDir) {
    return "·";
  }
  return isOpen ? "▾" : "▸";
}

/** Which repo should be active given the overview and the current selection: keep the current
    one if it still exists, otherwise the first dirty repo (else the first repo). `undefined` when
    there are no repos. */
function nextActiveRepo(repos: GitStatus[], activeRepo: string | undefined): string | undefined {
  if (repos.length === 0) {
    return undefined;
  }
  if (activeRepo !== undefined && repos.some((candidate) => candidate.root === activeRepo)) {
    return activeRepo;
  }
  const fallback = repos.find((candidate) => !candidate.clean) ?? repos[0];
  return fallback?.root ?? activeRepo;
}

/** The repo among `repos` that owns `filePath`: the one whose `.root` contains the file, picking
    the LONGEST matching root so a nested repo wins over its parent. `undefined` when none contain
    it. Used to keep Source Control following whichever file the editor is focused on. Exported for
    unit tests of the longest-prefix rule. */
export function repoForFile(repos: GitStatus[], filePath: string): string | undefined {
  let owner: string | undefined;
  for (const candidate of repos) {
    const contains = isWithin(filePath, candidate.root);
    if (contains && (owner === undefined || candidate.root.length > owner.length)) {
      owner = candidate.root;
    }
  }
  return owner;
}

/** The workspace root among `roots` that contains `repoRoot`, longest-prefix so the most specific
    root wins. `undefined` when none contain it. Lets a repo target pick the folder whose overview
    lists it. */
function owningWorkspaceRoot(roots: string[], repoRoot: string): string | undefined {
  let owner: string | undefined;
  for (const root of roots) {
    const contains = isWithin(repoRoot, root);
    if (contains && (owner === undefined || root.length > owner.length)) {
      owner = root;
    }
  }
  return owner;
}

/** Toggle a directory's expanded state, lazily loading its listing the first time it opens. */
function toggleExpandedDir(
  setExpandedDirs: Dispatch<SetStateAction<Set<string>>>,
  listings: Record<string, DirListing>,
  loadDir: (path: string) => void,
  path: string
): void {
  setExpandedDirs((prev) => {
    const next = new Set(prev);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (listings[path] === undefined) {
        loadDir(path);
      }
    }
    return next;
  });
}

/** Toggle a path's membership in a selection set. */
function togglePathInSet(setSelected: Dispatch<SetStateAction<Set<string>>>, path: string): void {
  setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return next;
  });
}

/** Re-read the open file + every expanded directory so the tree and viewer reflect disk. Skips
    re-reading the open file while it has unsaved edits (`dirty`), so a disk refresh never clobbers
    the draft in the editor. */
function refreshRepoTree(
  client: WireClient,
  loadDir: (path: string) => void,
  folder: string,
  expandedDirs: Set<string>,
  openPath: string | undefined,
  dirty: boolean
): void {
  if (folder !== "") {
    loadDir(folder);
  }
  for (const path of expandedDirs) {
    loadDir(path);
  }
  if (openPath !== undefined && !dirty) {
    void client.readFile(openPath).catch(() => undefined);
  }
}

/** The diff pane's setters + correlation ref, bundled so `openDiffInView` can live at module
    scope. The file editor is driven separately through the open-files list. */
interface DiffControls {
  client: WireClient;
  setViewerMode: Dispatch<SetStateAction<"file" | "diff">>;
  setDiff: Dispatch<SetStateAction<GitDiff | undefined>>;
  setFileVersions: Dispatch<SetStateAction<GitFileVersions | undefined>>;
  pendingDiff: RefObject<{ root: string; path?: string } | undefined>;
}

/** Open a changed file's diff into the centre pane. The unified `git_diff` still supplies the
    +/- stat header; a per-file diff additionally fetches both file versions (`git_file_versions`)
    to feed the side-by-side Monaco `DiffEditor`. The repo-level "all changes" case (no path) has
    no single pair of versions, so it stays on the unified patch. A rejected read leaves the pane
    on its loading placeholder. */
function openDiffInView(v: DiffControls, repoRoot: string, path?: string): void {
  v.setViewerMode("diff");
  v.setDiff(undefined);
  v.setFileVersions(undefined);
  v.pendingDiff.current = path === undefined ? { root: repoRoot } : { root: repoRoot, path };
  void v.client.gitDiff(repoRoot, path).catch(() => undefined);
  if (path !== undefined) {
    void v.client.gitFileVersions(repoRoot, path).catch(() => undefined);
  }
}

/** Run a git write op: mark busy, clear stale feedback, and gate behind the confirm modal when a
    message is supplied. The `git_op` event clears busy. */
function runGitWrite(
  setBusy: Dispatch<SetStateAction<boolean>>,
  setFeedback: Dispatch<SetStateAction<GitOpResult | undefined>>,
  setConfirm: Dispatch<SetStateAction<PendingConfirm | undefined>>,
  op: () => Promise<void>,
  confirmMessage?: string
): void {
  const fire = (): void => {
    setBusy(true);
    setFeedback(undefined);
    op().catch(() => setBusy(false));
  };
  if (confirmMessage === undefined) {
    fire();
  } else {
    setConfirm({ message: confirmMessage, action: fire });
  }
}

/** Everything the device-wide event subscription needs to fold a bridge event into this view's
    state. Bundled so the reducer can live at module scope (keeping the component's cognitive
    complexity down) while still reading the latest values through refs. */
interface RepoEventContext {
  client: WireClient;
  folderRef: RefObject<string>;
  activeRef: RefObject<boolean>;
  searchQueryRef: RefObject<string>;
  searchFlagsRef: RefObject<{ caseSensitive: boolean; wholeWord: boolean; isRegex: boolean }>;
  pendingDiff: RefObject<{ root: string; path?: string } | undefined>;
  savingPaths: RefObject<Set<string>>;
  refreshOverviewRef: RefObject<() => void>;
  refreshTreeRef: RefObject<() => void>;
  setListings: Dispatch<SetStateAction<Record<string, DirListing>>>;
  setOpenFiles: Dispatch<SetStateAction<OpenFile[]>>;
  setOverview: Dispatch<SetStateAction<GitOverview | undefined>>;
  setBranches: Dispatch<SetStateAction<GitBranches | undefined>>;
  setDiff: Dispatch<SetStateAction<GitDiff | undefined>>;
  setFileVersions: Dispatch<SetStateAction<GitFileVersions | undefined>>;
  setFeedback: Dispatch<SetStateAction<GitOpResult | undefined>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  setSearchResults: Dispatch<SetStateAction<ContentSearchResults | undefined>>;
  setFileHits: Dispatch<SetStateAction<SearchResults | undefined>>;
  setSearching: Dispatch<SetStateAction<boolean>>;
}

type FileWrittenResult = Extract<BridgeEvent["payload"], { kind: "file_written" }>["result"];

/** Fold freshly-read file contents into whichever open tab asked for them (matched by path).
    The functional update naturally scopes to open tabs, so contents read by another surface are
    ignored. The draft is re-seeded from disk unless the tab is dirty — the refresh path never
    re-reads a dirty file, so first-open, save-reread, and clean-refresh all re-seed correctly,
    while a genuine unsaved edit is preserved. */
function applyFileContents(file: FileContents, ctx: RepoEventContext): void {
  ctx.setOpenFiles((prev) =>
    prev.map((tab) => {
      if (tab.path !== file.path) {
        return tab;
      }
      const keepDraft = isDirtyTab(tab);
      return {
        ...tab,
        file,
        loading: false,
        error: undefined,
        draft: keepDraft ? tab.draft : file.content
      };
    })
  );
}

function applyGitDiff(diff: GitDiff, ctx: RepoEventContext): void {
  const want = ctx.pendingDiff.current;
  if (diff.root === want?.root && diff.path === want?.path) {
    ctx.setDiff(diff);
  }
}

function applyGitFileVersions(result: GitFileVersions, ctx: RepoEventContext): void {
  const want = ctx.pendingDiff.current;
  if (result.root === want?.root && result.path === want?.path) {
    ctx.setFileVersions(result);
  }
}

function applyGitOp(result: GitOpResult, ctx: RepoEventContext): void {
  ctx.setFeedback(result);
  ctx.setBusy(false);
  if (result.ok && result.op === "commit") {
    ctx.setCommitMessage("");
  }
}

function applyFileWritten(result: FileWrittenResult, ctx: RepoEventContext): void {
  // Only react to writes this view kicked off (tracked in savingPaths). Clear the tab's saving
  // state and, on success, re-read the file so its draft re-seeds from the persisted content
  // (clearing the dirty dot).
  if (!ctx.savingPaths.current.has(result.path)) {
    return;
  }
  ctx.savingPaths.current.delete(result.path);
  if (result.ok) {
    patchOpenFile(ctx.setOpenFiles, result.path, { saving: false, saveError: undefined });
    void ctx.client.readFile(result.path).catch(() => undefined);
  } else {
    patchOpenFile(ctx.setOpenFiles, result.path, {
      saving: false,
      saveError: result.message ?? "could not save the file"
    });
  }
}

/** Fold a content-search result set into state, but only when it answers the CURRENT scope +
    query + flags (the event bus is shared, and a superseded query's late result must not clobber
    a newer one; the same query with different case/word/regex flags is a different search).
    Clears the in-flight indicator once a correlated result lands. */
function applyContentSearchResults(results: ContentSearchResults, ctx: RepoEventContext): void {
  const flags = ctx.searchFlagsRef.current;
  if (
    results.root === ctx.folderRef.current &&
    results.query.trim() === ctx.searchQueryRef.current.trim() &&
    results.caseSensitive === flags.caseSensitive &&
    results.wholeWord === flags.wholeWord &&
    results.isRegex === flags.isRegex
  ) {
    ctx.setSearchResults(results);
    ctx.setSearching(false);
  }
}

/** Fold a filename-search result set into state when it answers the CURRENT scope + query (the
    filename search has no flags, so root + query is its full identity). */
function applyFileSearchResults(results: SearchResults, ctx: RepoEventContext): void {
  if (results.root === ctx.folderRef.current && results.query.trim() === ctx.searchQueryRef.current.trim()) {
    ctx.setFileHits(results);
  }
}

function applyFsChanged(paths: string[], ctx: RepoEventContext): void {
  if (
    ctx.activeRef.current &&
    ctx.folderRef.current !== "" &&
    paths.some((path) => isWithin(path, ctx.folderRef.current))
  ) {
    ctx.refreshOverviewRef.current();
    ctx.refreshTreeRef.current();
  }
}

/** Fold a single device-wide bridge event into this view's state. The bus is shared across
    surfaces, so each branch correlates the payload to what this view asked for before applying
    it. Lives at module scope so it doesn't count against the component's cognitive complexity. */
function applyRepoEvent(event: BridgeEvent, ctx: RepoEventContext): void {
  const payload = event.payload;
  switch (payload.kind) {
    case "dir_listing":
      ctx.setListings((prev) => ({ ...prev, [payload.listing.path]: payload.listing }));
      break;
    case "file_contents":
      applyFileContents(payload.file, ctx);
      break;
    case "git_overview":
      if (payload.overview.root === ctx.folderRef.current) {
        ctx.setOverview(payload.overview);
      }
      break;
    case "git_status":
      ctx.setOverview((prev) =>
        prev === undefined ? prev : replaceRepoStatus(prev, payload.status)
      );
      break;
    case "git_branches":
      ctx.setBranches(payload.branches);
      break;
    case "git_diff":
      applyGitDiff(payload.diff, ctx);
      break;
    case "git_file_versions":
      applyGitFileVersions(payload.result, ctx);
      break;
    case "git_op":
      applyGitOp(payload.result, ctx);
      break;
    case "file_written":
      applyFileWritten(payload.result, ctx);
      break;
    case "content_search_results":
      applyContentSearchResults(payload.results, ctx);
      break;
    case "search_results":
      applyFileSearchResults(payload.results, ctx);
      break;
    case "fs_changed":
      applyFsChanged(payload.paths, ctx);
      break;
    default:
      break;
  }
}

/** The git-write handlers for the source-control panel + context menu. */
interface RepoActions {
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onCheckout: (name: string, create: boolean) => void;
  onDiscardFile: (file: GitFileStatus) => void;
}

/** Build the git-write handlers bound to the active repo. Each is a no-op until a repo is
    active; extracted to module scope so the per-handler `repo` guards don't drive the
    component's cognitive complexity. Behaviour matches the previous inline
    `repo !== undefined && …` handlers exactly. */
function buildRepoActions(
  repo: GitStatus | undefined,
  client: WireClient,
  runWrite: (op: () => Promise<void>, confirmMessage?: string) => void,
  openDiff: (repoRoot: string, path?: string) => void,
  openFile: (path: string) => void,
  commitMessage: string
): RepoActions {
  if (repo === undefined) {
    const noop = (): void => undefined;
    return {
      onOpenDiff: noop,
      onOpenFile: noop,
      onStage: noop,
      onUnstage: noop,
      onCommit: noop,
      onPush: noop,
      onPull: noop,
      onCheckout: noop,
      onDiscardFile: noop
    };
  }
  const branchName = repo.branch ?? "this branch";
  return {
    onOpenDiff: (path) => openDiff(repo.root, path),
    onOpenFile: (path) => openFile(childPath(repo.root, path)),
    onStage: (paths) => runWrite(() => client.gitStage(repo.root, paths)),
    onUnstage: (paths) => runWrite(() => client.gitUnstage(repo.root, paths)),
    onCommit: () => runWrite(() => client.gitCommit(repo.root, commitMessage.trim())),
    onPush: () => runWrite(() => client.gitPush(repo.root), `Push ${branchName} to its remote?`),
    onPull: () =>
      runWrite(() => client.gitPull(repo.root), `Pull (fast-forward only) into ${branchName}?`),
    onCheckout: (name, create) =>
      runWrite(
        () => client.gitCheckout(repo.root, name, create),
        repo.clean
          ? undefined
          : `Switch to "${name}" with uncommitted changes? Your changes will follow if they don't conflict.`
      ),
    onDiscardFile: (target) =>
      runWrite(
        () => client.gitDiscard(repo.root, [target.path], target.untracked),
        `Discard changes to ${target.path}? This cannot be undone.`
      )
  };
}

interface ExplorerTreeProps {
  rootListing: DirListing | undefined;
  listings: Record<string, DirListing>;
  expandedDirs: Set<string>;
  openFilePath: string | undefined;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

/** The explorer's root level: a loading/empty hint, or the recursive tree. Extracted so the
    loading/empty/tree choice is a set of statements, not a nested ternary. */
function ExplorerTree({
  rootListing,
  listings,
  expandedDirs,
  openFilePath,
  onToggleDir,
  onOpenFile
}: Readonly<ExplorerTreeProps>): ReactElement {
  if (rootListing === undefined) {
    return <li className="repos-hint">Loading…</li>;
  }
  if (rootListing.entries.length === 0) {
    return <li className="repos-hint">Empty folder.</li>;
  }
  return (
    <TreeLevel
      listing={rootListing}
      depth={0}
      listings={listings}
      expandedDirs={expandedDirs}
      openFilePath={openFilePath}
      onToggleDir={onToggleDir}
      onOpenFile={onOpenFile}
    />
  );
}

interface RepoPickerProps {
  repos: GitStatus[];
  activeRepo: string | undefined;
  onSelectRepo: (root: string) => void;
}

/** The repository picker, shown only when the folder holds more than one repo. */
function RepoPicker({ repos, activeRepo, onSelectRepo }: Readonly<RepoPickerProps>): ReactElement | null {
  if (repos.length <= 1) {
    return null;
  }
  return (
    <select
      aria-label="Repository"
      value={activeRepo ?? ""}
      onChange={(event) => onSelectRepo(event.target.value)}
    >
      {repos.map((option) => (
        <option key={option.root} value={option.root}>
          {basename(option.root)}
          {option.clean ? "" : ` (${option.files.length})`}
        </option>
      ))}
    </select>
  );
}

interface BranchBarProps {
  repo: GitStatus;
  branches: GitBranches | undefined;
  busy: boolean;
  newBranch: string;
  onNewBranch: (value: string) => void;
  onCheckout: (name: string, create: boolean) => void;
  onPull: () => void;
  onPush: () => void;
}

/** Branch switcher, new-branch form, and pull/push actions for the active repo. */
function BranchBar({
  repo,
  branches,
  busy,
  newBranch,
  onNewBranch,
  onCheckout,
  onPull,
  onPush
}: Readonly<BranchBarProps>): ReactElement {
  const branchOptions = branches?.branches ?? (repo.branch === undefined ? [] : [repo.branch]);
  return (
    <div className="repos-branch-bar">
      <label className="repos-branch-switch">
        <span className="visually-hidden">Switch branch</span>
        <select
          aria-label="Switch branch"
          value={repo.branch ?? ""}
          disabled={busy || branches === undefined}
          onChange={(event) => {
            if (event.target.value !== "" && event.target.value !== repo.branch) {
              onCheckout(event.target.value, false);
            }
          }}
        >
          {repo.branch === undefined && <option value="">(detached)</option>}
          {branchOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="repos-new-branch"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newBranch.trim();
          if (name.length > 0) {
            onCheckout(name, true);
            onNewBranch("");
          }
        }}
      >
        <input
          aria-label="New branch name"
          value={newBranch}
          placeholder="new branch…"
          onChange={(event) => onNewBranch(event.target.value)}
        />
        <button type="submit" disabled={busy || newBranch.trim().length === 0}>
          Create
        </button>
      </form>
      <div className="repos-remote-actions">
        <button type="button" onClick={onPull} disabled={busy}>
          Pull{repo.behind > 0 ? ` ↓${repo.behind}` : ""}
        </button>
        <button type="button" onClick={onPush} disabled={busy}>
          Push{repo.ahead > 0 ? ` ↑${repo.ahead}` : ""}
        </button>
      </div>
    </div>
  );
}

interface RepoChangesProps {
  repo: GitStatus;
  commitMessage: string;
  busy: boolean;
  selected: Set<string>;
  onCommitMessage: (value: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: () => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onToggleSelected: (path: string) => void;
  onContextMenu: (target: ContextTarget) => void;
  onDiscardFile: (file: GitFileStatus) => void;
}

/** Staged/unstaged file groups and the commit box for the active repo, or a clean-tree hint. */
function RepoChanges({
  repo,
  commitMessage,
  busy,
  selected,
  onCommitMessage,
  onStage,
  onUnstage,
  onCommit,
  onOpenDiff,
  onOpenFile,
  onToggleSelected,
  onContextMenu,
  onDiscardFile
}: Readonly<RepoChangesProps>): ReactElement {
  const grouped = useMemo(() => groupFiles(repo.files), [repo]);
  if (repo.clean) {
    return <p className="repos-hint">Working tree clean.</p>;
  }
  const stagedCount = grouped.staged.length;
  const canCommit = stagedCount > 0 && commitMessage.trim().length > 0 && !busy;
  return (
    <div className="repos-changes">
      {stagedCount > 0 && (
        <ScmGroup
          title="Staged"
          files={grouped.staged}
          staged
          action="Unstage"
          allLabel="Unstage all"
          selected={selected}
          busy={busy}
          repoRoot={repo.root}
          onAction={(file) => onUnstage([file.path])}
          onActionAll={() => onUnstage(["."])}
          onOpenDiff={onOpenDiff}
          onOpenFile={onOpenFile}
          onToggleSelected={onToggleSelected}
          onContextMenu={onContextMenu}
          onDiscard={onDiscardFile}
        />
      )}
      {grouped.unstaged.length > 0 && (
        <ScmGroup
          title="Changes"
          files={grouped.unstaged}
          staged={false}
          action="Stage"
          allLabel="Stage all"
          selected={selected}
          busy={busy}
          repoRoot={repo.root}
          onAction={(file) => onStage([file.path])}
          onActionAll={() => onStage(["."])}
          onOpenDiff={onOpenDiff}
          onOpenFile={onOpenFile}
          onToggleSelected={onToggleSelected}
          onContextMenu={onContextMenu}
          onDiscard={onDiscardFile}
        />
      )}
      <div className="repos-commit">
        <textarea
          aria-label="Commit message"
          value={commitMessage}
          placeholder={stagedCount === 0 ? "Stage changes to commit…" : "Commit message…"}
          rows={2}
          onChange={(event) => onCommitMessage(event.target.value)}
        />
        <button type="button" className="git-commit-button" onClick={onCommit} disabled={!canCommit}>
          Commit{" "}
          {stagedCount > 0 ? `(${stagedCount})` : ""}
        </button>
      </div>
    </div>
  );
}

/** The activity rail's "Explorer" glyph: a document/file page. */
function ExplorerIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M9.3 1.6H4a1 1 0 0 0-1 1v10.8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3L9.3 1.6Z" strokeLinejoin="round" />
      <path d="M9.2 1.7v3.8h3.7" strokeLinejoin="round" />
    </svg>
  );
}

/** The activity rail's "Source control" glyph: a git branch. */
function BranchIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="4.6" cy="3" r="1.7" />
      <circle cx="4.6" cy="13" r="1.7" />
      <circle cx="11.4" cy="4.4" r="1.7" />
      <path d="M4.6 4.7v6.6" strokeLinecap="round" />
      <path d="M11.4 6.1c0 2.9-2.3 3.4-4.3 3.9-1 .3-1.9.7-2.3 1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The activity rail's "Search" glyph: a magnifier. */
function SearchIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="4.4" />
      <path d="M10 10l3.4 3.4" strokeLinecap="round" />
    </svg>
  );
}

type LeftPanel = "explorer" | "sourceControl" | "search";

interface ActivityRailProps {
  active: LeftPanel;
  /** Changed files in the active repo — surfaced as a small badge on the Source control icon
      (0 = no badge). */
  changeCount: number;
  onSelect: (panel: LeftPanel) => void;
}

/** The far-left activity rail (VS Code model): switches the sidebar between the file explorer, the
    repo-wide search panel, and the source-control panel. Only the active icon is highlighted; the
    panels themselves swap. The Source control icon carries a change-count badge when the active
    repo has uncommitted files. */
function ActivityRail({ active, changeCount, onSelect }: Readonly<ActivityRailProps>): ReactElement {
  return (
    <nav className="repos-rail" aria-label="Views">
      <button
        type="button"
        className={`repos-rail-btn${active === "explorer" ? " is-active" : ""}`}
        aria-label="Explorer"
        aria-pressed={active === "explorer"}
        title="Explorer"
        onClick={() => onSelect("explorer")}
      >
        <ExplorerIcon />
      </button>
      <button
        type="button"
        className={`repos-rail-btn${active === "search" ? " is-active" : ""}`}
        aria-label="Search"
        aria-pressed={active === "search"}
        title="Search"
        onClick={() => onSelect("search")}
      >
        <SearchIcon />
      </button>
      <button
        type="button"
        className={`repos-rail-btn${active === "sourceControl" ? " is-active" : ""}`}
        aria-label={changeCount > 0 ? `Source control (${changeCount} changes)` : "Source control"}
        aria-pressed={active === "sourceControl"}
        title="Source control"
        onClick={() => onSelect("sourceControl")}
      >
        <BranchIcon />
        {changeCount > 0 && (
          <span className="repos-rail-badge" aria-hidden="true">
            {changeCount}
          </span>
        )}
      </button>
    </nav>
  );
}

/** Where the current search reveal points, so the editor can scroll to a clicked match. The
    `nonce` forces a re-reveal even when the same line is clicked twice. */
interface RevealTarget {
  path: string;
  line: number;
  nonce: number;
}

/** Group a flat match list by file, preserving first-seen order (the bridge already returns
    matches grouped per file, so this keeps that order for the collapsible headers). */
function groupMatchesByFile(matches: ContentMatch[]): Array<{ path: string; matches: ContentMatch[] }> {
  const order: string[] = [];
  const byPath = new Map<string, ContentMatch[]>();
  for (const match of matches) {
    const existing = byPath.get(match.path);
    if (existing === undefined) {
      byPath.set(match.path, [match]);
      order.push(match.path);
    } else {
      existing.push(match);
    }
  }
  return order.map((path) => ({ path, matches: byPath.get(path) ?? [] }));
}

/** The length (in code points) of the matched substring at `start` in `text`, so the highlight
    covers exactly the hit. Literal searches use the query length; a regex is matched stickily at
    the match start (an invalid regex highlights nothing). */
function matchLength(
  text: string,
  start: number,
  query: string,
  caseSensitive: boolean,
  regex: boolean
): number {
  const trimmed = query.trim();
  if (!regex) {
    return [...trimmed].length;
  }
  // Regex highlighting only: the operator explicitly enabled regex-search mode, so the
  // pattern is their own, matched against a single already-capped line (<= the bridge's
  // MAX_LINE_TEXT_CHARS) in their own browser; an overlong pattern is skipped as a cheap
  // catastrophic-backtracking guard, and a bad pattern is caught below.
  if (trimmed.length > MAX_HIGHLIGHT_PATTERN_LEN) {
    return 0;
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- operator's own regex, capped line, self-scoped (see above)
    const sticky = new RegExp(trimmed, `${caseSensitive ? "" : "i"}y`); // NOSONAR: user-intended regex-search feature on own local files
    const sub = [...text].slice(start).join("");
    sticky.lastIndex = 0;
    const found = sticky.exec(sub);
    return found !== null ? [...found[0]].length : 0;
  } catch {
    return 0;
  }
}

/** Longest regex-search pattern honored for highlighting; a longer one is skipped as a
    cheap guard against a pathological backtracking pattern. */
const MAX_HIGHLIGHT_PATTERN_LEN = 200;

/** Split a matched line into the text before the hit, the hit itself, and the text after — so the
    hit can be wrapped in a `<mark>`. Works in code points so multi-byte characters stay intact. */
function highlightSegments(
  match: ContentMatch,
  query: string,
  caseSensitive: boolean,
  regex: boolean
): { before: string; hit: string; after: string } {
  const chars = [...match.lineText];
  const start = Math.max(0, (match.column ?? 1) - 1);
  const length = matchLength(match.lineText, start, query, caseSensitive, regex);
  if (length <= 0 || start >= chars.length) {
    return { before: match.lineText, hit: "", after: "" };
  }
  return {
    before: chars.slice(0, start).join(""),
    hit: chars.slice(start, start + length).join(""),
    after: chars.slice(start + length).join("")
  };
}

interface SearchPanelProps {
  /** The folder the search is scoped to (shown in the input placeholder). */
  scopeLabel: string;
  /** The scope's absolute root, used to render file hits with a repo-relative dir. */
  scopeRoot: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  searching: boolean;
  error: string | undefined;
  results: ContentSearchResults | undefined;
  /** Filename hits for the same query (files whose NAME contains the query). */
  fileHits: SearchResults | undefined;
  onQuery: (value: string) => void;
  onToggleCase: () => void;
  onToggleWord: () => void;
  onToggleRegex: () => void;
  onOpenMatch: (match: ContentMatch) => void;
  onOpenFile: (path: string) => void;
}

/** The repo-wide search panel (VS Code's "Find in Files"): a debounced query input, the
    case/word/regex toggles, and results grouped by file with the matched substring highlighted.
    Clicking a match asks the parent to open the file at that line. */
function SearchPanel({
  scopeLabel,
  scopeRoot,
  query,
  caseSensitive,
  wholeWord,
  regex,
  searching,
  error,
  results,
  fileHits,
  onQuery,
  onToggleCase,
  onToggleWord,
  onToggleRegex,
  onOpenMatch,
  onOpenFile
}: Readonly<SearchPanelProps>): ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = (path: string) => togglePathInSet(setCollapsed, path);
  const groups = useMemo(() => groupMatchesByFile(results?.matches ?? []), [results]);

  return (
    <div className="repos-search" aria-label="Search">
      <p className="repos-pane-title">Search</p>
      <div className="repos-search-controls">
        <input
          className="repos-search-input"
          aria-label="Search in files"
          type="search"
          value={query}
          placeholder={`Search in ${scopeLabel}…`}
          onChange={(event) => onQuery(event.target.value)}
        />
        <div className="repos-search-toggles" role="group" aria-label="Search options">
          <button
            type="button"
            className={`repos-search-toggle${caseSensitive ? " is-active" : ""}`}
            aria-label="Match case"
            aria-pressed={caseSensitive}
            title="Match case"
            onClick={onToggleCase}
          >
            Aa
          </button>
          <button
            type="button"
            className={`repos-search-toggle${wholeWord ? " is-active" : ""}`}
            aria-label="Match whole word"
            aria-pressed={wholeWord}
            title="Match whole word"
            onClick={onToggleWord}
          >
            W
          </button>
          <button
            type="button"
            className={`repos-search-toggle${regex ? " is-active" : ""}`}
            aria-label="Use regular expression"
            aria-pressed={regex}
            title="Use regular expression"
            onClick={onToggleRegex}
          >
            .*
          </button>
        </div>
      </div>
      <FileHitsSection query={query} scopeRoot={scopeRoot} fileHits={fileHits} onOpenFile={onOpenFile} />
      <SearchResultsBody
        query={query}
        searching={searching}
        error={error}
        results={results}
        groups={groups}
        collapsed={collapsed}
        caseSensitive={caseSensitive}
        regex={regex}
        hasFileHits={fileHits !== undefined && fileHits.hits.length > 0}
        onToggleCollapsed={toggleCollapsed}
        onOpenMatch={onOpenMatch}
      />
    </div>
  );
}

/** Cap on filename hits rendered in the panel (the bridge caps the walk separately). */
const MAX_FILE_HITS_SHOWN = 25;

interface FileHitsSectionProps {
  query: string;
  scopeRoot: string;
  fileHits: SearchResults | undefined;
  onOpenFile: (path: string) => void;
}

/** Files whose NAME contains the query (the "open the file called 0043" case), listed above the
    content matches. Each hit shows the filename plus its scope-relative folder; clicking opens
    the file in the editor. */
function FileHitsSection({
  query,
  scopeRoot,
  fileHits,
  onOpenFile
}: Readonly<FileHitsSectionProps>): ReactElement | null {
  if (query.trim() === "" || fileHits === undefined || fileHits.hits.length === 0) {
    return null;
  }
  const shown = fileHits.hits.slice(0, MAX_FILE_HITS_SHOWN);
  const hidden = fileHits.hits.length - shown.length;
  const fileWord = fileHits.hits.length === 1 ? "file" : "files";
  return (
    <div className="repos-search-filehits">
      <p className="repos-search-summary">
        {fileHits.hits.length} matching {fileWord}
        {(hidden > 0 || fileHits.truncated) && (
          <span className="repos-search-truncated"> · showing the first {shown.length}</span>
        )}
      </p>
      <ul className="repos-search-groups">
        {shown.map((hit) => (
          <li key={hit.path} className="repos-search-group">
            <button
              type="button"
              className="repos-search-file-head"
              title={hit.path}
              onClick={() => onOpenFile(hit.path)}
            >
              <span aria-hidden="true">{fileIcon(hit.name)}</span>
              <span className="repos-search-filename">{hit.name}</span>
              <span className="repos-search-filedir">{relativeDirLabel(hit.path, hit.name, scopeRoot)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The scope-relative folder a hit lives in ("src/routes"), or "." at the scope root. */
function relativeDirLabel(path: string, name: string, scopeRoot: string): string {
  let dir = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/, "");
  if (scopeRoot !== "" && dir.toLowerCase().startsWith(scopeRoot.toLowerCase())) {
    dir = dir.slice(scopeRoot.length).replace(/^[\\/]+/, "");
  }
  return dir === "" ? "." : dir.replaceAll("\\", "/");
}

interface SearchResultsBodyProps {
  query: string;
  searching: boolean;
  error: string | undefined;
  results: ContentSearchResults | undefined;
  groups: Array<{ path: string; matches: ContentMatch[] }>;
  collapsed: Set<string>;
  caseSensitive: boolean;
  regex: boolean;
  /** True when the filename section above already lists hits, so an empty content result reads
      "no content matches" instead of a flat (and then wrong-looking) "no results". */
  hasFileHits: boolean;
  onToggleCollapsed: (path: string) => void;
  onOpenMatch: (match: ContentMatch) => void;
}

/** The results region under the search controls: empty-query (blank), searching, error, no-match,
    or the grouped result list with a summary + truncation notice. */
function SearchResultsBody({
  query,
  searching,
  error,
  results,
  groups,
  collapsed,
  caseSensitive,
  regex,
  hasFileHits,
  onToggleCollapsed,
  onOpenMatch
}: Readonly<SearchResultsBodyProps>): ReactElement | null {
  if (query.trim() === "") {
    // Empty query = empty panel (no results shown).
    return null;
  }
  if (error !== undefined) {
    return (
      <p role="alert" className="settings-error">
        {error}
      </p>
    );
  }
  if (results === undefined) {
    return <p className="repos-hint">{searching ? "Searching…" : ""}</p>;
  }
  if (results.matches.length === 0) {
    return <p className="repos-hint">{hasFileHits ? "No content matches." : "No results."}</p>;
  }
  const fileWord = results.fileCount === 1 ? "file" : "files";
  const matchWord = results.matches.length === 1 ? "result" : "results";
  return (
    <div className="repos-search-results">
      <p className="repos-search-summary">
        {results.matches.length} {matchWord} in {results.fileCount} {fileWord}
        {results.truncated && (
          <span className="repos-search-truncated"> · showing the first {results.matches.length} (more not shown)</span>
        )}
      </p>
      <ul className="repos-search-groups">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.path);
          return (
            <li key={group.path} className="repos-search-group">
              <button
                type="button"
                className="repos-search-file-head"
                aria-expanded={!isCollapsed}
                onClick={() => onToggleCollapsed(group.path)}
                title={group.path}
              >
                <span className="repos-search-caret" aria-hidden="true">
                  {isCollapsed ? "▸" : "▾"}
                </span>
                <span className="repos-search-filename">{basename(group.path)}</span>
                <span className="repos-file-count">{group.matches.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="repos-search-matches">
                  {group.matches.map((match) => {
                    const seg = highlightSegments(match, query, caseSensitive, regex);
                    return (
                      <li key={`${match.line}:${match.column ?? 0}:${match.lineText}`}>
                        <button
                          type="button"
                          className="repos-search-match"
                          title={`${group.path}:${match.line}`}
                          onClick={() => onOpenMatch(match)}
                        >
                          <span className="repos-search-lineno">{match.line}</span>
                          <span className="repos-search-linetext">
                            {seg.before}
                            {seg.hit !== "" && <mark className="repos-search-hit">{seg.hit}</mark>}
                            {seg.after}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Repositories: HoneyHub's IDE surface (PRD-0011 Amendment 2). One page that merges the
 * old Browse + Git surfaces, laid out like VS Code: a far-left activity rail switches the
 * sidebar between an explorer tree and a source-control panel (multi-select + right-click
 * menu), while the center pane always holds the Monaco editor for the open file (saved
 * through the bridge's `write_file` boundary, ADR-0097) or a changed file's diff. Reads are
 * free; every git write is confirmation-gated and a save writes only the local working tree
 * (PRs-as-artifacts holds).
 */
export function RepositoriesView({
  client,
  active,
  workspaceRoots,
  defaultWorkspaceRoot,
  selectedRepo,
  onSelectedRepoConsumed
}: Readonly<RepositoriesViewProps>): ReactElement {
  const [folder, setFolder] = useState<string>(() =>
    resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot)
  );

  // Explorer tree: each expanded directory's listing, keyed by path, plus the set of
  // expanded directory paths. The root's children are the listing for `folder`.
  const [listings, setListings] = useState<Record<string, DirListing>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

  // Source control (git) for the selected folder.
  const [overview, setOverview] = useState<GitOverview | undefined>(undefined);
  const [activeRepo, setActiveRepo] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<GitBranches | undefined>(undefined);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [feedback, setFeedback] = useState<GitOpResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<ContextTarget | undefined>(undefined);

  // Which panel the far-left activity rail shows (VS Code model): the explorer tree, the repo-wide
  // search panel, or the source-control panel. Only one is mounted at a time; the Monaco editor
  // always holds the centre.
  const [leftPanel, setLeftPanel] = useState<LeftPanel>("explorer");

  // Repo-wide search (VS Code "Find in Files"): the debounced query, its case/word/regex flags, the
  // in-flight indicator, the last error, and the latest results. Scoped to the selected `folder`.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [searchResults, setSearchResults] = useState<ContentSearchResults | undefined>(undefined);
  // Filename hits for the same query (the "find the file named 0043" case): the panel runs the
  // bridge's filename search alongside the content search and lists matching files first.
  const [fileHits, setFileHits] = useState<SearchResults | undefined>(undefined);
  // Where a clicked search match wants the editor to scroll (path + 1-based line + a re-reveal nonce).
  const [revealTarget, setRevealTarget] = useState<RevealTarget | undefined>(undefined);

  // Center pane: the editor (a tab strip of open files) or a diff.
  const [viewerMode, setViewerMode] = useState<"file" | "diff">("file");
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);
  // The two file versions for the side-by-side Monaco diff (per-file only; the repo-level
  // "all changes" case has no single pair and stays on the unified patch).
  const [fileVersions, setFileVersions] = useState<GitFileVersions | undefined>(undefined);

  // Editor tabs: the ordered list of open files (each with its own draft + status) and which one
  // is active. Opening a file adds/activates its tab; the active tab's editor holds the centre.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | undefined>(undefined);

  const activeFile = openFiles.find((tab) => tab.path === activeFilePath);
  const activeDirty = activeFile !== undefined && isDirtyTab(activeFile);
  // The reveal target applies only to the currently-active tab (so switching tabs doesn't drag a
  // stale search jump onto another file).
  const revealForActive =
    activeFile !== undefined && revealTarget?.path === activeFile.path ? revealTarget : undefined;
  // Every open tab with unsaved edits (drives the "N unsaved" indicator + the Save-all gate).
  const dirtyTabs = openFiles.filter(isDirtyTab);
  const dirtyCount = dirtyTabs.length;

  // Refs so the [client]-only subscription reads the latest without re-subscribing.
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Latest overview, read synchronously by the follow-file effect so it can derive the owning repo
  // without re-subscribing when the overview refreshes (which would fight a manual repo pick).
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const pendingDiff = useRef<{ root: string; path?: string } | undefined>(undefined);
  // Paths with a save in flight, tracked synchronously so `file_written` events (which can arrive
  // before React re-renders) correlate to the tab that asked for the write.
  const savingPaths = useRef<Set<string>>(new Set());
  // Mirror of the open-files list + active path, read synchronously by the open/close handlers so
  // they can decide (e.g. "is this file already open?") without waiting for a re-render.
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  // Latest search query + flags, read synchronously by the event fold so a stale (superseded)
  // result set for an earlier query or an earlier flag combination is ignored.
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchFlagsRef = useRef({
    caseSensitive: searchCaseSensitive,
    wholeWord: searchWholeWord,
    isRegex: searchRegex
  });
  searchFlagsRef.current = {
    caseSensitive: searchCaseSensitive,
    wholeWord: searchWholeWord,
    isRegex: searchRegex
  };

  const loadDir = useCallback(
    (path: string) => {
      void client.browseDir(path).catch(() => undefined);
    },
    [client]
  );

  const refreshOverview = useCallback(() => {
    if (folder !== "") {
      void client.gitOverview(folder).catch(() => undefined);
    }
  }, [client, folder]);
  const refreshOverviewRef = useRef(refreshOverview);
  refreshOverviewRef.current = refreshOverview;

  // Re-read the active open file + every expanded directory (so the tree and viewer reflect disk).
  const refreshTree = useCallback(() => {
    refreshRepoTree(client, loadDir, folderRef.current, expandedDirs, activeFile?.path, activeDirty);
  }, [client, loadDir, expandedDirs, activeFile?.path, activeDirty]);
  const refreshTreeRef = useRef(refreshTree);
  refreshTreeRef.current = refreshTree;

  // The single device-wide event subscription. The bus is shared across surfaces, so every
  // handler correlates the payload to what this view asked for before applying it. The folding
  // logic lives in `applyRepoEvent` (module scope) and reads the latest values through refs.
  useEffect(() => {
    const ctx: RepoEventContext = {
      client,
      folderRef,
      activeRef,
      searchQueryRef,
      searchFlagsRef,
      pendingDiff,
      savingPaths,
      refreshOverviewRef,
      refreshTreeRef,
      setListings,
      setOpenFiles,
      setOverview,
      setBranches,
      setDiff,
      setFileVersions,
      setFeedback,
      setBusy,
      setCommitMessage,
      setSearchResults,
      setFileHits,
      setSearching
    };
    return client.subscribe((event) => applyRepoEvent(event, ctx));
  }, [client]);

  // Load the root listing + git overview when the view activates or the folder changes.
  useEffect(() => {
    if (active && folder !== "") {
      loadDir(folder);
      refreshOverview();
    }
  }, [active, folder, loadDir, refreshOverview]);

  // Follow the resolved default until the user picks a folder.
  useEffect(() => {
    if (folder === "" && workspaceRoots.length > 0) {
      setFolder(resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot));
    }
  }, [folder, workspaceRoots, defaultWorkspaceRoot]);

  // Slow-poll fallback for when the host filesystem watcher is unavailable.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onFocus = () => {
      refreshOverviewRef.current();
      refreshTreeRef.current();
    };
    window.addEventListener("focus", onFocus);
    const interval = setInterval(onFocus, 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [active]);

  // Default the active repo to the first repo that has changes, else the first repo.
  useEffect(() => {
    const next = nextActiveRepo(overview?.repos ?? [], activeRepo);
    if (next !== activeRepo) {
      setActiveRepo(next);
    }
  }, [overview, activeRepo]);

  // Load branches for the active repo.
  useEffect(() => {
    if (activeRepo !== undefined) {
      setBranches(undefined);
      client.gitBranches(activeRepo).catch(() => undefined);
    }
  }, [client, activeRepo]);

  // Debounced repo-wide content search: fire `searchContent` a beat after the query/flags settle,
  // scoped to the selected `folder`. An empty query clears the panel; the result lands via the
  // `content_search_results` fold (correlated by root+query). Only runs while the panel is open.
  useEffect(() => {
    if (!active || leftPanel !== "search") {
      return;
    }
    const trimmed = searchQuery.trim();
    if (trimmed === "" || folder === "") {
      setSearchResults(undefined);
      setFileHits(undefined);
      setSearching(false);
      setSearchError(undefined);
      return;
    }
    setSearching(true);
    setSearchError(undefined);
    const handle = setTimeout(() => {
      void client
        .searchContent(folder, trimmed, {
          caseSensitive: searchCaseSensitive,
          wholeWord: searchWholeWord,
          isRegex: searchRegex
        })
        .catch((cause: unknown) => {
          setSearching(false);
          setSearchError(errorMessage(cause, "search failed"));
        });
      // The filename search rides the same query (its own result event, correlated
      // independently); a failure here never blocks the content results.
      void client.searchFiles(folder, trimmed).catch(() => undefined);
    }, 250);
    return () => clearTimeout(handle);
  }, [
    active,
    leftPanel,
    searchQuery,
    searchCaseSensitive,
    searchWholeWord,
    searchRegex,
    folder,
    client
  ]);

  const toggleDir = (path: string) => toggleExpandedDir(setExpandedDirs, listings, loadDir, path);

  const diffControls: DiffControls = { client, setViewerMode, setDiff, setFileVersions, pendingDiff };
  const openDiff = (repoRoot: string, path?: string) => openDiffInView(diffControls, repoRoot, path);

  // Open a file into a tab: activate it if already open (keeping any unsaved edit), otherwise add
  // a loading tab and read it. `openFilesRef` is read synchronously so we read from disk exactly
  // once even though the mock/host may emit `file_contents` before React commits the new tab.
  const openFile = (path: string): void => {
    setViewerMode("file");
    setActiveFilePath(path);
    if (openFilesRef.current.some((tab) => tab.path === path)) {
      return;
    }
    setOpenFiles((prev) => (prev.some((tab) => tab.path === path) ? prev : [...prev, newOpenFile(path)]));
    void client.readFile(path).catch((cause: unknown) => {
      patchOpenFile(setOpenFiles, path, {
        loading: false,
        error: errorMessage(cause, "could not read file")
      });
    });
  };

  // Open a search match: open (or focus) its file in a tab through the same path as any other
  // open, then record a reveal target so the editor scrolls to + selects the matched line. The
  // nonce makes clicking the same match twice re-scroll.
  const openFileAtLine = (path: string, line: number): void => {
    openFile(path);
    setRevealTarget({ path, line, nonce: Date.now() });
  };
  const onOpenMatch = (match: ContentMatch): void => openFileAtLine(match.path, match.line);

  const activateTab = (path: string): void => {
    setViewerMode("file");
    setActiveFilePath(path);
  };

  // Close a tab; when it was the active tab, fall back to the neighbour (next, else previous).
  const closeTab = (path: string): void => {
    const prev = openFilesRef.current;
    const index = prev.findIndex((tab) => tab.path === path);
    if (index === -1) {
      return;
    }
    const next = prev.filter((tab) => tab.path !== path);
    savingPaths.current.delete(path);
    setOpenFiles(next);
    if (path === activeFilePathRef.current) {
      const neighbour = next[index] ?? next[index - 1];
      setActiveFilePath(neighbour?.path);
    }
  };

  // Edit/save/revert operate on the active tab.
  const setActiveDraft = (value: string): void => {
    patchOpenFile(setOpenFiles, activeFilePathRef.current ?? "", { draft: value });
  };
  // Write one open tab through the bridge's write_file boundary (shared by single Save + Save all).
  // A tab with no on-disk contents yet, or a truncated (read-only) file, is skipped. The write path
  // marks the tab saving, and the `file_written` event (or a rejection) clears it and re-seeds the
  // draft so the dirty dot lifts.
  const writeTab = (tab: OpenFile): void => {
    if (tab.file === undefined || tab.file.truncated) {
      return;
    }
    savingPaths.current.add(tab.path);
    patchOpenFile(setOpenFiles, tab.path, { saving: true, saveError: undefined });
    void client.writeFile(tab.path, tab.draft).catch((cause: unknown) => {
      if (savingPaths.current.has(tab.path)) {
        savingPaths.current.delete(tab.path);
        patchOpenFile(setOpenFiles, tab.path, {
          saving: false,
          saveError: errorMessage(cause, "could not save the file")
        });
      }
    });
  };
  const saveDraft = (): void => {
    const tab = openFilesRef.current.find((candidate) => candidate.path === activeFilePathRef.current);
    if (tab !== undefined) {
      writeTab(tab);
    }
  };
  // Save every dirty open tab through the same write path as the single-file Save.
  const saveAll = (): void => {
    for (const tab of openFilesRef.current) {
      if (isDirtyTab(tab)) {
        writeTab(tab);
      }
    }
  };
  const revertDraft = (): void => {
    const tab = openFilesRef.current.find((candidate) => candidate.path === activeFilePathRef.current);
    if (tab?.file !== undefined) {
      patchOpenFile(setOpenFiles, tab.path, { draft: tab.file.content, saveError: undefined });
    }
  };
  const runWrite = (op: () => Promise<void>, confirmMessage?: string) =>
    runGitWrite(setBusy, setFeedback, setConfirm, op, confirmMessage);

  // Switch the whole surface to a new workspace folder, resetting the tree, open tabs, and git
  // state (shared by the folder picker and an incoming repo target).
  const switchFolder = (next: string): void => {
    setFolder(next);
    setExpandedDirs(new Set());
    setListings({});
    setOverview(undefined);
    setActiveRepo(undefined);
    setOpenFiles([]);
    setActiveFilePath(undefined);
    savingPaths.current.clear();
    setViewerMode("file");
    setDiff(undefined);
    // The search results belong to the old folder — clear them (the query text is kept so the
    // user can re-run it against the new scope).
    setSearchResults(undefined);
    setSearching(false);
    setSearchError(undefined);
    setRevealTarget(undefined);
  };

  const repo = overview?.repos.find((candidate) => candidate.root === activeRepo);
  const repoActions = buildRepoActions(repo, client, runWrite, openDiff, openFile, commitMessage);

  // Selection is scoped to the active repo; reset it when the repo changes.
  useEffect(() => {
    setSelected(new Set());
  }, [activeRepo]);

  // Follow the focused file: when the active tab's file belongs to a different repo than the one
  // Source Control shows, point Source Control at that repo (longest-prefix match, so a nested repo
  // wins). Keyed on `activeFilePath` alone — reading the overview through a ref — so it fires only
  // on a file open/switch and never re-overrides a manual repo pick when the overview refreshes.
  useEffect(() => {
    if (activeFilePath === undefined) {
      return;
    }
    const owner = repoForFile(overviewRef.current?.repos ?? [], activeFilePath);
    if (owner !== undefined) {
      setActiveRepo((prev) => (owner === prev ? prev : owner));
    }
  }, [activeFilePath]);

  // Honor a repo handed in from elsewhere (e.g. the Hub's changes list): move to its owning
  // workspace folder if that differs, focus Source Control on the repo, and tell the parent it was
  // consumed so the one-shot target clears (a later manual repo pick then stands). Keyed on
  // `selectedRepo` so re-selecting the same repo (target: undefined → root) re-fires.
  useEffect(() => {
    if (selectedRepo === undefined) {
      return;
    }
    const owningRoot = owningWorkspaceRoot(workspaceRoots, selectedRepo);
    if (owningRoot !== undefined && owningRoot !== folderRef.current) {
      switchFolder(owningRoot);
    }
    setActiveRepo(selectedRepo);
    setLeftPanel("sourceControl");
    onSelectedRepoConsumed?.();
    // switchFolder/onSelectedRepoConsumed are stable enough for this one-shot; deps intentionally
    // track only the incoming target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo]);

  const toggleSelected = (path: string) => togglePathInSet(setSelected, path);

  if (workspaceRoots.length === 0) {
    return (
      <section className="repos" aria-label="Repositories">
        <header className="repos-header">
          <h2>Repositories</h2>
        </header>
        <p className="repos-empty">
          Add a workspace in Settings to browse files, view diffs, and edit code here.
        </p>
      </section>
    );
  }

  const rootListing = listings[folder];

  return (
    <section className="repos" aria-label="Repositories">
      <header className="repos-header">
        <h2>Repositories</h2>
        <div className="repos-actions">
          <select
            aria-label="Workspace folder"
            value={folder}
            onChange={(event) => switchFolder(event.target.value)}
          >
            {workspaceRoots.map((option) => (
              <option key={option} value={option}>
                {basename(option)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              refreshOverview();
              refreshTree();
            }}
          >
            Refresh
          </button>
          <span className="live-dot" title="Live: updates when files change on disk" aria-hidden="true" />
        </div>
      </header>

      <div className="repos-body">
        <ActivityRail active={leftPanel} changeCount={repo?.files.length ?? 0} onSelect={setLeftPanel} />

        {leftPanel === "explorer" && (
          <aside className="repos-sidebar" aria-label="Explorer">
            <p className="repos-pane-title">Files</p>
            <ul className="repos-tree">
              <ExplorerTree
                rootListing={rootListing}
                listings={listings}
                expandedDirs={expandedDirs}
                openFilePath={activeFilePath}
                onToggleDir={toggleDir}
                onOpenFile={openFile}
              />
            </ul>
          </aside>
        )}

        {leftPanel === "search" && (
          <aside className="repos-sidebar" aria-label="Search panel">
            <SearchPanel
              scopeLabel={basename(folder)}
              scopeRoot={folder}
              query={searchQuery}
              caseSensitive={searchCaseSensitive}
              wholeWord={searchWholeWord}
              regex={searchRegex}
              searching={searching}
              error={searchError}
              results={searchResults}
              fileHits={fileHits}
              onQuery={setSearchQuery}
              onToggleCase={() => setSearchCaseSensitive((prev) => !prev)}
              onToggleWord={() => setSearchWholeWord((prev) => !prev)}
              onToggleRegex={() => setSearchRegex((prev) => !prev)}
              onOpenMatch={onOpenMatch}
              onOpenFile={openFile}
            />
          </aside>
        )}

        {leftPanel === "sourceControl" && (
          <aside className="repos-sidebar" aria-label="Source control panel">
            <SourceControl
              repos={overview?.repos ?? []}
              repo={repo}
              activeRepo={activeRepo}
              branches={branches}
              commitMessage={commitMessage}
              newBranch={newBranch}
              feedback={feedback}
              busy={busy}
              selected={selected}
              onSelectRepo={setActiveRepo}
              onCommitMessage={setCommitMessage}
              onNewBranch={setNewBranch}
              onOpenDiff={repoActions.onOpenDiff}
              onOpenFile={repoActions.onOpenFile}
              onToggleSelected={toggleSelected}
              onContextMenu={(target) => setMenu(target)}
              onStage={repoActions.onStage}
              onUnstage={repoActions.onUnstage}
              onCommit={repoActions.onCommit}
              onPush={repoActions.onPush}
              onPull={repoActions.onPull}
              onCheckout={repoActions.onCheckout}
              onDiscardFile={repoActions.onDiscardFile}
            />
          </aside>
        )}

        <div className="repos-viewer">
          {openFiles.length > 0 && (
            <div className="repos-editor-tabbar">
              <EditorTabs
                tabs={openFiles.map((tab) => ({ path: tab.path, dirty: isDirtyTab(tab) }))}
                activePath={viewerMode === "file" ? activeFilePath : undefined}
                onActivate={activateTab}
                onClose={closeTab}
              />
              <div className="repos-editor-actions">
                {dirtyCount > 0 && (
                  <span className="repos-unsaved" aria-live="polite">
                    • {dirtyCount} unsaved
                  </span>
                )}
                <button
                  type="button"
                  className="git-link repos-save-all"
                  onClick={saveAll}
                  disabled={dirtyCount === 0}
                >
                  Save all
                </button>
              </div>
            </div>
          )}
          {viewerMode === "diff" ? (
            <DiffPane diff={diff} fileVersions={fileVersions} />
          ) : (
            <FilePane
              file={activeFile?.file}
              loading={activeFile?.loading ?? false}
              error={activeFile?.error}
              draft={activeFile?.draft ?? ""}
              dirty={activeDirty}
              saving={activeFile?.saving ?? false}
              saveError={activeFile?.saveError}
              revealLine={revealForActive?.line}
              revealNonce={revealForActive?.nonce}
              lspClient={client}
              repoRoot={
                activeFile === undefined
                  ? undefined
                  : repoForFile(overview?.repos ?? [], activeFile.path)
              }
              onDraft={setActiveDraft}
              onSave={saveDraft}
              onRevert={revertDraft}
            />
          )}
        </div>
      </div>

      {menu !== undefined && (
        <RepoContextMenu
          target={menu}
          onClose={() => setMenu(undefined)}
          onOpenDiff={repoActions.onOpenDiff}
          onOpenFile={repoActions.onOpenFile}
          onStage={repoActions.onStage}
          onUnstage={repoActions.onUnstage}
          onDiscard={repoActions.onDiscardFile}
        />
      )}

      {confirm !== undefined && (
        <dialog className="git-confirm-backdrop" aria-label="Confirm action" open>
          <div className="git-confirm">
            <p className="git-confirm-message">{confirm.message}</p>
            <div className="git-confirm-actions">
              <button
                type="button"
                className="git-confirm-yes"
                onClick={() => {
                  confirm.action();
                  setConfirm(undefined);
                }}
              >
                Confirm
              </button>
              <button type="button" onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        </dialog>
      )}
    </section>
  );
}

interface TreeLevelProps {
  listing: DirListing;
  depth: number;
  listings: Record<string, DirListing>;
  expandedDirs: Set<string>;
  openFilePath: string | undefined;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

/** One level of the explorer tree, recursing into expanded directories. */
function TreeLevel({
  listing,
  depth,
  listings,
  expandedDirs,
  openFilePath,
  onToggleDir,
  onOpenFile
}: Readonly<TreeLevelProps>): ReactElement {
  return (
    <>
      {listing.entries.map((entry) => {
        const path = childPath(listing.path, entry.name);
        const isDir = entry.kind === "dir";
        const isOpen = expandedDirs.has(path);
        const childListing = listings[path];
        return (
          <li key={path}>
            <button
              type="button"
              className={`repos-tree-row${!isDir && openFilePath === path ? " is-open" : ""}`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => (isDir ? onToggleDir(path) : onOpenFile(path))}
            >
              <span className="repos-tree-caret" aria-hidden="true">
                {caretGlyph(isDir, isOpen)}
              </span>
              <span className="repos-tree-icon" aria-hidden="true">
                {isDir ? folderIcon(isOpen) : fileIcon(entry.name)}
              </span>
              <span className="repos-tree-name">{entry.name}</span>
            </button>
            {isDir && isOpen && childListing !== undefined && childListing.entries.length > 0 && (
              <ul className="repos-tree">
                <TreeLevel
                  listing={childListing}
                  depth={depth + 1}
                  listings={listings}
                  expandedDirs={expandedDirs}
                  openFilePath={openFilePath}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

interface SourceControlProps {
  repos: GitStatus[];
  repo: GitStatus | undefined;
  activeRepo: string | undefined;
  branches: GitBranches | undefined;
  commitMessage: string;
  newBranch: string;
  feedback: GitOpResult | undefined;
  busy: boolean;
  selected: Set<string>;
  onSelectRepo: (root: string) => void;
  onCommitMessage: (value: string) => void;
  onNewBranch: (value: string) => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onToggleSelected: (path: string) => void;
  onContextMenu: (target: ContextTarget) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onCheckout: (name: string, create: boolean) => void;
  onDiscardFile: (file: GitFileStatus) => void;
}

/** The source-control panel: repo picker, branch controls, staged/unstaged files with
    multi-select and a context menu, and the commit box. */
function SourceControl({
  repos,
  repo,
  activeRepo,
  branches,
  commitMessage,
  newBranch,
  feedback,
  busy,
  selected,
  onSelectRepo,
  onCommitMessage,
  onNewBranch,
  onOpenDiff,
  onOpenFile,
  onToggleSelected,
  onContextMenu,
  onStage,
  onUnstage,
  onCommit,
  onPush,
  onPull,
  onCheckout,
  onDiscardFile
}: Readonly<SourceControlProps>): ReactElement {
  const selectedList = [...selected];

  return (
    <div className="repos-scm" aria-label="Source control">
      <div className="repos-scm-head">
        <p className="repos-pane-title">Source control</p>
        <RepoPicker repos={repos} activeRepo={activeRepo} onSelectRepo={onSelectRepo} />
      </div>

      {repo === undefined ? (
        <p className="repos-hint">No git repository in this folder.</p>
      ) : (
        <>
          <BranchBar
            repo={repo}
            branches={branches}
            busy={busy}
            newBranch={newBranch}
            onNewBranch={onNewBranch}
            onCheckout={onCheckout}
            onPull={onPull}
            onPush={onPush}
          />

          {feedback !== undefined && (
            <output className={`git-feedback ${feedback.ok ? "is-ok" : "is-error"}`}>
              {feedback.message ?? (feedback.ok ? `${feedback.op} ok` : `${feedback.op} failed`)}
            </output>
          )}

          {selectedList.length > 0 && (
            <div className="repos-bulk">
              <span>{selectedList.length} selected</span>
              <button type="button" className="git-link" onClick={() => onStage(selectedList)} disabled={busy}>
                Stage
              </button>
              <button type="button" className="git-link" onClick={() => onUnstage(selectedList)} disabled={busy}>
                Unstage
              </button>
            </div>
          )}

          <RepoChanges
            repo={repo}
            commitMessage={commitMessage}
            busy={busy}
            selected={selected}
            onCommitMessage={onCommitMessage}
            onStage={onStage}
            onUnstage={onUnstage}
            onCommit={onCommit}
            onOpenDiff={onOpenDiff}
            onOpenFile={onOpenFile}
            onToggleSelected={onToggleSelected}
            onContextMenu={onContextMenu}
            onDiscardFile={onDiscardFile}
          />
        </>
      )}
    </div>
  );
}

/** The CSS modifier for a file's status badge. */
function fileCodeKind(file: GitFileStatus): "untracked" | "staged" | "dirty" {
  if (file.untracked) {
    return "untracked";
  }
  return file.staged ? "staged" : "dirty";
}

interface ScmGroupProps {
  title: string;
  files: GitFileStatus[];
  staged: boolean;
  action: string;
  allLabel: string;
  selected: Set<string>;
  busy: boolean;
  repoRoot: string;
  onAction: (file: GitFileStatus) => void;
  onActionAll: () => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onToggleSelected: (path: string) => void;
  onContextMenu: (target: ContextTarget) => void;
  onDiscard: (file: GitFileStatus) => void;
}

function ScmGroup({
  title,
  files,
  staged,
  action,
  allLabel,
  selected,
  busy,
  repoRoot,
  onAction,
  onActionAll,
  onOpenDiff,
  onOpenFile,
  onToggleSelected,
  onContextMenu,
  onDiscard
}: Readonly<ScmGroupProps>): ReactElement {
  return (
    <div className="repos-scm-group">
      <div className="repos-scm-group-head">
        <span className="repos-scm-group-title">
          {title} <span className="repos-file-count">{files.length}</span>
        </span>
        <button type="button" className="git-link" onClick={onActionAll} disabled={busy}>
          {allLabel}
        </button>
      </div>
      <ul className="repos-files">
        {files.map((file) => {
          const codeKind = fileCodeKind(file);
          const isSelected = selected.has(file.path);
          return (
            <li key={file.path} className={`repos-file-row${isSelected ? " is-selected" : ""}`}>
              <button
                type="button"
                className="repos-file"
                onClick={(event) => {
                  // Ctrl/Cmd-click toggles multi-selection; a plain click opens the diff.
                  if (event.ctrlKey || event.metaKey) {
                    onToggleSelected(file.path);
                  } else {
                    onOpenDiff(file.path);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu({ x: event.clientX, y: event.clientY, repoRoot, file, staged });
                }}
              >
                <span className={`git-code code-${codeKind}`}>{file.status}</span>
                <span className="repos-file-path">{file.path}</span>
              </button>
              <div className="repos-file-actions">
                <button type="button" className="git-link" onClick={() => onAction(file)} disabled={busy}>
                  {action}
                </button>
                <button
                  type="button"
                  className="git-link git-discard"
                  onClick={() => onDiscard(file)}
                  disabled={busy}
                >
                  Discard
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface RepoContextMenuProps {
  target: ContextTarget;
  onClose: () => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (file: GitFileStatus) => void;
}

/** A Visual-Studio-style right-click menu for a changed file. */
function RepoContextMenu({
  target,
  onClose,
  onOpenDiff,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard
}: Readonly<RepoContextMenuProps>): ReactElement {
  const { file, staged } = target;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <>
      <button type="button" className="ws-backdrop" aria-label="Close menu" onClick={onClose} />
      <div
        className="repos-context-menu"
        role="menu"
        aria-label="File actions"
        style={{ left: `${target.x}px`, top: `${target.y}px` }}
      >
        <button type="button" role="menuitem" onClick={act(() => onOpenDiff(file.path))}>
          Open diff
        </button>
        <button type="button" role="menuitem" onClick={act(() => onOpenFile(file.path))}>
          Open file
        </button>
        {staged ? (
          <button type="button" role="menuitem" onClick={act(() => onUnstage([file.path]))}>
            Unstage
          </button>
        ) : (
          <button type="button" role="menuitem" onClick={act(() => onStage([file.path]))}>
            Stage
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={act(() => {
            void globalThis.navigator?.clipboard?.writeText(file.path).catch(() => undefined);
          })}
        >
          Copy path
        </button>
        <button type="button" role="menuitem" className="git-discard" onClick={act(() => onDiscard(file))}>
          Discard
        </button>
      </div>
    </>
  );
}

interface FilePaneProps {
  file: FileContents | undefined;
  loading: boolean;
  error: string | undefined;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string | undefined;
  /** A 1-based line to scroll to + select (set when a search match is clicked). */
  revealLine?: number | undefined;
  /** Bumps to force a re-reveal of the same line. */
  revealNonce?: number | undefined;
  /** The bridge wire client, threaded to the editor for LSP code intelligence (ADR-0102). */
  lspClient?: WireClient | undefined;
  /** The open file's owning repo root, scoping its language server. */
  repoRoot?: string | undefined;
  onDraft: (value: string) => void;
  onSave: () => void;
  onRevert: () => void;
}

/** The center pane's file editor: the file opens directly in a Monaco editor (honeypunk theme,
    syntax highlighting, IntelliSense). Save (button or Ctrl/Cmd+S) crosses the bridge's
    `write_file` boundary (ADR-0097); Revert restores the on-disk text. A truncated (too-large)
    file opens read-only. Monaco is lazy-loaded, so the pane shows a fallback on first open.
    Markdown files add an Edit/Preview toggle: Preview renders the live draft as HTML so unsaved
    edits show, while Save still writes from Edit. */
function FilePane({
  file,
  loading,
  error,
  draft,
  dirty,
  saving,
  saveError,
  revealLine,
  revealNonce,
  lspClient,
  repoRoot,
  onDraft,
  onSave,
  onRevert
}: Readonly<FilePaneProps>): ReactElement {
  const [previewMode, setPreviewMode] = useState(false);
  // A quiet, honest note when a language server is not running/installed for this file
  // (undefined when a server is running or no LSP applies). Shown unobtrusively in the header.
  const [lspNote, setLspNote] = useState<string | undefined>(undefined);
  const path = file?.path;
  const markdown = path !== undefined && isMarkdownFile(path);
  // Each newly opened file defaults to Edit; reset the toggle whenever the open file changes.
  useEffect(() => {
    setPreviewMode(false);
  }, [path]);
  // Clear the stale note when the open file changes; the editor re-reports for the new file.
  useEffect(() => {
    setLspNote(undefined);
  }, [path]);

  if (loading) {
    return <div className="file-viewer empty">Loading…</div>;
  }
  if (error !== undefined) {
    return (
      <div className="file-viewer empty">
        <p role="alert" className="settings-error">
          {error}
        </p>
      </div>
    );
  }
  if (file === undefined) {
    return <div className="file-viewer empty">Select a file to open it in the editor.</div>;
  }

  const showPreview = markdown && previewMode;

  return (
    <div className="file-viewer">
      <header className="file-viewer-head">
        <span className="file-viewer-name">
          {basename(file.path)}
          {dirty ? " •" : ""}
        </span>
        <span className="file-viewer-actions">
          {markdown && (
            <span className="file-viewer-modes" role="group" aria-label="Markdown view">
              <button
                type="button"
                className={`file-viewer-mode${showPreview ? "" : " is-active"}`}
                aria-pressed={!showPreview}
                onClick={() => setPreviewMode(false)}
              >
                Edit
              </button>
              <button
                type="button"
                className={`file-viewer-mode${showPreview ? " is-active" : ""}`}
                aria-pressed={showPreview}
                onClick={() => setPreviewMode(true)}
              >
                Preview
              </button>
            </span>
          )}
          <span className="file-viewer-meta">
            {file.truncated ? "truncated (too large to edit)" : lspNote !== undefined ? lspNote : ""}
          </span>
          <button type="button" className="git-link" onClick={onRevert} disabled={saving || !dirty}>
            Revert
          </button>
          <button
            type="button"
            className="git-link"
            onClick={onSave}
            disabled={saving || !dirty || file.truncated}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </header>

      {saveError !== undefined && (
        <p role="alert" className="settings-error">
          {saveError}
        </p>
      )}

      {showPreview ? (
        <article className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />
      ) : (
        <div className="repos-editor-host" data-reveal-line={revealLine ?? undefined}>
          <Suspense fallback={<div className="file-viewer empty">Loading editor…</div>}>
            <CodeEditor
              path={file.path}
              value={draft}
              onChange={onDraft}
              onSave={onSave}
              readOnly={file.truncated}
              revealLine={revealLine}
              revealNonce={revealNonce}
              lspClient={lspClient}
              repoRoot={repoRoot}
              onLspStatus={setLspNote}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/** The diff pane. A per-file diff renders the two file versions in a side-by-side Monaco
    `DiffEditor` (the `+/-` stat header still comes from the unified `git_diff`). The repo-level
    "all changes" case — which has no single pair of versions — falls back to the coloured
    unified patch. */
function DiffPane({
  diff,
  fileVersions
}: Readonly<{ diff: GitDiff | undefined; fileVersions: GitFileVersions | undefined }>): ReactElement {
  const stat = useMemo(() => (diff === undefined ? undefined : diffStat(diff.patch)), [diff]);
  const diffLines = useMemo(() => (diff === undefined ? [] : toDiffLines(diff.patch)), [diff]);
  const diffKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return diffLines.map((line) => {
      const base = `${line.kind}:${line.text}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { key: `${base}#${occurrence}`, line };
    });
  }, [diffLines]);

  // Nothing to show yet: neither the stat nor the versions have arrived.
  if (diff === undefined && fileVersions === undefined) {
    return <div className="file-viewer empty">Loading diff…</div>;
  }

  const path = fileVersions?.path ?? diff?.path ?? "All changes";
  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-path">{path}</span>
        {stat !== undefined && (
          <span className="git-diff-stat">
            <span className="stat-add">+{stat.added}</span> <span className="stat-del">-{stat.removed}</span>
          </span>
        )}
      </div>
      {fileVersions !== undefined ? (
        <div className="repos-editor-host" aria-label="Diff">
          <Suspense fallback={<div className="file-viewer empty">Loading diff…</div>}>
            <DiffViewer
              path={fileVersions.path}
              original={fileVersions.original}
              modified={fileVersions.modified}
            />
          </Suspense>
        </div>
      ) : diff !== undefined && diff.patch.trim().length === 0 ? (
        <p className="repos-hint">No diff (the change may be untracked or staged only).</p>
      ) : (
        <figure className="diff-figure" aria-label="Diff">
          <pre className="diff-view">
            {diffKeys.map(({ key, line }) => (
              <span key={key} className={`diff-line diff-${line.kind}`}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </figure>
      )}
      {diff?.truncated && <p className="git-truncated">Diff truncated (very large change).</p>}
    </div>
  );
}
