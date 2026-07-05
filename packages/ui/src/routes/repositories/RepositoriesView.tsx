import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactElement, RefObject, SetStateAction } from "react";
import type {
  BridgeEvent,
  DirListing,
  FileContents,
  GitBranches,
  GitDiff,
  GitFileStatus,
  GitOpResult,
  GitOverview,
  GitStatus
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { basename, isWithin } from "../../paths";
import { resolveDefaultWorkspaceRoot } from "../../settingsModel";
import { diffStat, groupFiles, replaceRepoStatus, toDiffLines } from "../git/gitModel";

// Monaco is heavy, so the file editor is loaded only once a file is opened. The base bundle
// (and the mobile PWA that never touches a file) stays light; a <Suspense> fallback covers the
// one-time chunk fetch.
const CodeEditor = lazy(() => import("./CodeEditor"));

export interface RepositoriesViewProps {
  client: WireClient;
  active: boolean;
  /** Allowlisted workspace roots (folders or single repos) to pick from. */
  workspaceRoots: string[];
  /** The user's default workspace, pre-selected here. */
  defaultWorkspaceRoot?: string;
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

/** The centre-pane setters + correlation refs, bundled so the file/diff/editor handlers can live
    at module scope (keeping the component's cognitive complexity down). */
interface ViewerControls {
  client: WireClient;
  setViewerMode: Dispatch<SetStateAction<"file" | "diff">>;
  setFile: Dispatch<SetStateAction<FileContents | undefined>>;
  setFileLoading: Dispatch<SetStateAction<boolean>>;
  setFileError: Dispatch<SetStateAction<string | undefined>>;
  setDiff: Dispatch<SetStateAction<GitDiff | undefined>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setSaveError: Dispatch<SetStateAction<string | undefined>>;
  pendingFile: RefObject<string | undefined>;
  pendingDiff: RefObject<{ root: string; path?: string } | undefined>;
  savingPath: RefObject<string | undefined>;
}

/** Open a file straight into the centre pane's editor, correlating the async reply by path.
    The editor's initial draft is seeded from the file contents when they arrive (see
    `applyFileContents`). */
function openFileInView(v: ViewerControls, path: string): void {
  v.setViewerMode("file");
  v.setSaveError(undefined);
  v.pendingFile.current = path;
  v.setFile(undefined);
  v.setFileError(undefined);
  v.setFileLoading(true);
  void v.client.readFile(path).catch((cause: unknown) => {
    if (v.pendingFile.current === path) {
      v.setFileLoading(false);
      v.setFileError(errorMessage(cause, "could not read file"));
    }
  });
}

/** Open a changed file's diff into the centre pane. */
function openDiffInView(v: ViewerControls, repoRoot: string, path?: string): void {
  v.setViewerMode("diff");
  v.setDiff(undefined);
  v.setFileError(undefined);
  v.pendingDiff.current = path === undefined ? { root: repoRoot } : { root: repoRoot, path };
  void v.client.gitDiff(repoRoot, path).catch(() => v.setFileError("could not read the diff"));
}

/** Save the editor draft through the bridge's write_file boundary (ADR-0097). */
function saveFileDraft(v: ViewerControls, file: FileContents | undefined, draft: string): void {
  if (file === undefined) {
    return;
  }
  v.setSaving(true);
  v.setSaveError(undefined);
  v.savingPath.current = file.path;
  void v.client.writeFile(file.path, draft).catch((cause: unknown) => {
    if (v.savingPath.current === file.path) {
      v.setSaving(false);
      v.savingPath.current = undefined;
      v.setSaveError(errorMessage(cause, "could not save the file"));
    }
  });
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
  pendingFile: RefObject<string | undefined>;
  pendingDiff: RefObject<{ root: string; path?: string } | undefined>;
  savingPath: RefObject<string | undefined>;
  refreshOverviewRef: RefObject<() => void>;
  refreshTreeRef: RefObject<() => void>;
  setListings: Dispatch<SetStateAction<Record<string, DirListing>>>;
  setFile: Dispatch<SetStateAction<FileContents | undefined>>;
  setFileLoading: Dispatch<SetStateAction<boolean>>;
  setFileError: Dispatch<SetStateAction<string | undefined>>;
  setOverview: Dispatch<SetStateAction<GitOverview | undefined>>;
  setBranches: Dispatch<SetStateAction<GitBranches | undefined>>;
  setDiff: Dispatch<SetStateAction<GitDiff | undefined>>;
  setFeedback: Dispatch<SetStateAction<GitOpResult | undefined>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setSaveError: Dispatch<SetStateAction<string | undefined>>;
}

type FileWrittenResult = Extract<BridgeEvent["payload"], { kind: "file_written" }>["result"];

function applyFileContents(file: FileContents, ctx: RepoEventContext): void {
  if (ctx.pendingFile.current === undefined || file.path === ctx.pendingFile.current) {
    ctx.setFile(file);
    ctx.setFileLoading(false);
    ctx.setFileError(undefined);
    // Seed (or re-seed, after a save) the editor draft from disk. The refresh path won't
    // re-read an open file while it's dirty, so this never clobbers unsaved edits.
    ctx.setDraft(file.content);
  }
}

function applyGitDiff(diff: GitDiff, ctx: RepoEventContext): void {
  const want = ctx.pendingDiff.current;
  if (diff.root === want?.root && diff.path === want?.path) {
    ctx.setDiff(diff);
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
  // Our own save came back. Clear the saving state and, on success, re-read the file so the
  // editor's draft is re-seeded from the persisted content (clearing the dirty indicator).
  if (result.path !== ctx.savingPath.current) {
    return;
  }
  ctx.setSaving(false);
  ctx.savingPath.current = undefined;
  if (result.ok) {
    ctx.setSaveError(undefined);
    ctx.pendingFile.current = result.path;
    void ctx.client.readFile(result.path).catch(() => undefined);
  } else {
    ctx.setSaveError(result.message ?? "could not save the file");
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
    case "git_op":
      applyGitOp(payload.result, ctx);
      break;
    case "file_written":
      applyFileWritten(payload.result, ctx);
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

type LeftPanel = "explorer" | "sourceControl";

interface ActivityRailProps {
  active: LeftPanel;
  onSelect: (panel: LeftPanel) => void;
}

/** The far-left activity rail (VS Code model): switches the sidebar between the file explorer and
    the source-control panel. Only the active icon is highlighted; the panels themselves swap. */
function ActivityRail({ active, onSelect }: Readonly<ActivityRailProps>): ReactElement {
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
        className={`repos-rail-btn${active === "sourceControl" ? " is-active" : ""}`}
        aria-label="Source control"
        aria-pressed={active === "sourceControl"}
        title="Source control"
        onClick={() => onSelect("sourceControl")}
      >
        <BranchIcon />
      </button>
    </nav>
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
  defaultWorkspaceRoot
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

  // Which panel the far-left activity rail shows (VS Code model): the explorer tree or the
  // source-control panel. Only one is mounted at a time; the Monaco editor always holds the centre.
  const [leftPanel, setLeftPanel] = useState<LeftPanel>("explorer");

  // Center pane: a file (viewed or edited) or a diff.
  const [viewerMode, setViewerMode] = useState<"file" | "diff">("file");
  const [file, setFile] = useState<FileContents | undefined>(undefined);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);

  // Editor state. The file always opens directly in the editor; `draft` is the live editor text,
  // seeded from disk and compared against the file to derive the dirty indicator.
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const error = fileError;
  // Unsaved edits: a non-truncated open file whose editor text has diverged from disk.
  const dirty = file !== undefined && !file.truncated && draft !== file.content;

  // Refs so the [client]-only subscription reads the latest without re-subscribing.
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pendingFile = useRef<string | undefined>(undefined);
  const pendingDiff = useRef<{ root: string; path?: string } | undefined>(undefined);
  const savingPath = useRef<string | undefined>(undefined);

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

  // Re-read the open file + every expanded directory (so the tree and viewer reflect disk).
  const refreshTree = useCallback(() => {
    refreshRepoTree(client, loadDir, folderRef.current, expandedDirs, pendingFile.current, dirty);
  }, [client, loadDir, expandedDirs, dirty]);
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
      pendingFile,
      pendingDiff,
      savingPath,
      refreshOverviewRef,
      refreshTreeRef,
      setListings,
      setFile,
      setFileLoading,
      setFileError,
      setOverview,
      setBranches,
      setDiff,
      setFeedback,
      setBusy,
      setCommitMessage,
      setSaving,
      setDraft,
      setSaveError
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

  const toggleDir = (path: string) => toggleExpandedDir(setExpandedDirs, listings, loadDir, path);

  // The file/diff/editor handlers live at module scope over this bundle of centre-pane setters.
  const viewer: ViewerControls = {
    client,
    setViewerMode,
    setFile,
    setFileLoading,
    setFileError,
    setDiff,
    setSaving,
    setSaveError,
    pendingFile,
    pendingDiff,
    savingPath
  };
  const openFile = (path: string) => openFileInView(viewer, path);
  const openDiff = (repoRoot: string, path?: string) => openDiffInView(viewer, repoRoot, path);
  const saveDraft = () => saveFileDraft(viewer, file, draft);
  const revertDraft = () => {
    if (file !== undefined) {
      setDraft(file.content);
    }
    setSaveError(undefined);
  };
  const runWrite = (op: () => Promise<void>, confirmMessage?: string) =>
    runGitWrite(setBusy, setFeedback, setConfirm, op, confirmMessage);

  const repo = overview?.repos.find((candidate) => candidate.root === activeRepo);
  const repoActions = buildRepoActions(repo, client, runWrite, openDiff, openFile, commitMessage);

  // Selection is scoped to the active repo; reset it when the repo changes.
  useEffect(() => {
    setSelected(new Set());
  }, [activeRepo]);

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
            onChange={(event) => {
              setFolder(event.target.value);
              setExpandedDirs(new Set());
              setListings({});
              setOverview(undefined);
              setActiveRepo(undefined);
              setFile(undefined);
              setDiff(undefined);
              setSaveError(undefined);
            }}
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
        <ActivityRail active={leftPanel} onSelect={setLeftPanel} />

        {leftPanel === "explorer" ? (
          <aside className="repos-sidebar" aria-label="Explorer">
            <p className="repos-pane-title">Files</p>
            <ul className="repos-tree">
              <ExplorerTree
                rootListing={rootListing}
                listings={listings}
                expandedDirs={expandedDirs}
                openFilePath={file?.path}
                onToggleDir={toggleDir}
                onOpenFile={openFile}
              />
            </ul>
          </aside>
        ) : (
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
          {viewerMode === "diff" ? (
            <DiffPane diff={diff} />
          ) : (
            <FilePane
              file={file}
              loading={fileLoading}
              error={error}
              draft={draft}
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              onDraft={setDraft}
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
  onDraft: (value: string) => void;
  onSave: () => void;
  onRevert: () => void;
}

/** The center pane's file editor: the file opens directly in a Monaco editor (honeypunk theme,
    syntax highlighting, IntelliSense). Save (button or Ctrl/Cmd+S) crosses the bridge's
    `write_file` boundary (ADR-0097); Revert restores the on-disk text. A truncated (too-large)
    file opens read-only. Monaco is lazy-loaded, so the pane shows a fallback on first open. */
function FilePane({
  file,
  loading,
  error,
  draft,
  dirty,
  saving,
  saveError,
  onDraft,
  onSave,
  onRevert
}: Readonly<FilePaneProps>): ReactElement {
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

  return (
    <div className="file-viewer">
      <header className="file-viewer-head">
        <span className="file-viewer-name">
          {basename(file.path)}
          {dirty ? " •" : ""}
        </span>
        <span className="file-viewer-actions">
          <span className="file-viewer-meta">{file.truncated ? "truncated (too large to edit)" : ""}</span>
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

      <div className="repos-editor-host">
        <Suspense fallback={<div className="file-viewer empty">Loading editor…</div>}>
          <CodeEditor
            path={file.path}
            value={draft}
            onChange={onDraft}
            onSave={onSave}
            readOnly={file.truncated}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** The diff pane: a changed file's unified diff, coloured line by line. */
function DiffPane({ diff }: Readonly<{ diff: GitDiff | undefined }>): ReactElement {
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

  if (diff === undefined) {
    return <div className="file-viewer empty">Loading diff…</div>;
  }
  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-path">{diff.path ?? "All changes"}</span>
        {stat !== undefined && (
          <span className="git-diff-stat">
            <span className="stat-add">+{stat.added}</span> <span className="stat-del">-{stat.removed}</span>
          </span>
        )}
      </div>
      {diff.patch.trim().length === 0 ? (
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
      {diff.truncated && <p className="git-truncated">Diff truncated (very large change).</p>}
    </div>
  );
}
