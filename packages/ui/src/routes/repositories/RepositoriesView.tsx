import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type {
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
import { highlightSource, isMarkdownFile, renderMarkdown } from "../browse/fileView";

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

/**
 * Repositories: HoneyHub's IDE surface (PDR-0011 Amendment 2). One page that merges the
 * old Browse + Git surfaces: an explorer tree on the left, a source-control panel with
 * multi-select and a right-click menu, and a center pane that views a file (syntax
 * highlighted), edits it in place (saved through the bridge's `write_file` boundary,
 * ADR-0097), or shows a changed file's diff. Reads are free; every git write is
 * confirmation-gated and a save writes only the local working tree (PRs-as-artifacts holds).
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

  // Center pane: a file (viewed or edited) or a diff.
  const [viewerMode, setViewerMode] = useState<"file" | "diff">("file");
  const [file, setFile] = useState<FileContents | undefined>(undefined);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);

  // Editor state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const error = fileError;

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
    if (folderRef.current !== "") {
      loadDir(folderRef.current);
    }
    for (const path of expandedDirs) {
      loadDir(path);
    }
    const openPath = pendingFile.current;
    if (openPath !== undefined && !editing) {
      void client.readFile(openPath).catch(() => undefined);
    }
  }, [client, loadDir, expandedDirs, editing]);
  const refreshTreeRef = useRef(refreshTree);
  refreshTreeRef.current = refreshTree;

  // The single device-wide event subscription. The bus is shared across surfaces, so every
  // handler correlates the payload to what this view asked for before applying it.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "dir_listing") {
        setListings((prev) => ({ ...prev, [payload.listing.path]: payload.listing }));
      } else if (payload.kind === "file_contents") {
        if (pendingFile.current === undefined || payload.file.path === pendingFile.current) {
          setFile(payload.file);
          setFileLoading(false);
          setFileError(undefined);
        }
      } else if (payload.kind === "git_overview") {
        if (payload.overview.root === folderRef.current) {
          setOverview(payload.overview);
        }
      } else if (payload.kind === "git_status") {
        setOverview((prev) => (prev === undefined ? prev : replaceRepoStatus(prev, payload.status)));
      } else if (payload.kind === "git_branches") {
        setBranches(payload.branches);
      } else if (payload.kind === "git_diff") {
        const want = pendingDiff.current;
        if (payload.diff.root === want?.root && payload.diff.path === want?.path) {
          setDiff(payload.diff);
        }
      } else if (payload.kind === "git_op") {
        setFeedback(payload.result);
        setBusy(false);
        if (payload.result.ok && payload.result.op === "commit") {
          setCommitMessage("");
        }
      } else if (payload.kind === "file_written") {
        // Our own save came back. Clear the saving state and, on success, leave edit mode
        // and re-read the file so the viewer shows the persisted content.
        if (payload.result.path === savingPath.current) {
          setSaving(false);
          savingPath.current = undefined;
          if (payload.result.ok) {
            setEditing(false);
            setSaveError(undefined);
            pendingFile.current = payload.result.path;
            void client.readFile(payload.result.path).catch(() => undefined);
          } else {
            setSaveError(payload.result.message ?? "could not save the file");
          }
        }
      } else if (payload.kind === "fs_changed") {
        if (
          activeRef.current &&
          folderRef.current !== "" &&
          payload.paths.some((path) => isWithin(path, folderRef.current))
        ) {
          refreshOverviewRef.current();
          refreshTreeRef.current();
        }
      }
    });
    return unsubscribe;
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
    const repos = overview?.repos ?? [];
    if (repos.length === 0) {
      setActiveRepo(undefined);
      return;
    }
    if (activeRepo === undefined || !repos.some((repo) => repo.root === activeRepo)) {
      const fallback = repos.find((repo) => !repo.clean) ?? repos[0];
      if (fallback !== undefined) {
        setActiveRepo(fallback.root);
      }
    }
  }, [overview, activeRepo]);

  // Load branches for the active repo.
  useEffect(() => {
    if (activeRepo !== undefined) {
      setBranches(undefined);
      client.gitBranches(activeRepo).catch(() => undefined);
    }
  }, [client, activeRepo]);

  const toggleDir = (path: string) => {
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
  };

  const openFile = (path: string) => {
    setViewerMode("file");
    setEditing(false);
    setSaveError(undefined);
    pendingFile.current = path;
    setFile(undefined);
    setFileError(undefined);
    setFileLoading(true);
    void client.readFile(path).catch((cause: unknown) => {
      if (pendingFile.current === path) {
        setFileLoading(false);
        setFileError(cause instanceof Error ? cause.message : "could not read file");
      }
    });
  };

  const openDiff = (repoRoot: string, path?: string) => {
    setViewerMode("diff");
    setDiff(undefined);
    setFileError(undefined);
    pendingDiff.current = path === undefined ? { root: repoRoot } : { root: repoRoot, path };
    void client.gitDiff(repoRoot, path).catch(() => setFileError("could not read the diff"));
  };

  const startEditing = () => {
    if (file === undefined || file.truncated) {
      return;
    }
    setDraft(file.content);
    setSaveError(undefined);
    setEditing(true);
  };

  const saveDraft = () => {
    if (file === undefined) {
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    savingPath.current = file.path;
    void client.writeFile(file.path, draft).catch((cause: unknown) => {
      if (savingPath.current === file.path) {
        setSaving(false);
        savingPath.current = undefined;
        setSaveError(cause instanceof Error ? cause.message : "could not save the file");
      }
    });
  };

  // Run a git write op: mark busy, clear stale feedback, gate behind the confirm modal when
  // a message is supplied. The git_op event clears busy.
  const runWrite = (op: () => Promise<void>, confirmMessage?: string) => {
    const fire = () => {
      setBusy(true);
      setFeedback(undefined);
      op().catch(() => setBusy(false));
    };
    if (confirmMessage === undefined) {
      fire();
    } else {
      setConfirm({ message: confirmMessage, action: fire });
    }
  };

  const repo = overview?.repos.find((candidate) => candidate.root === activeRepo);

  // Selection is scoped to the active repo; reset it when the repo changes.
  useEffect(() => {
    setSelected(new Set());
  }, [activeRepo]);

  const toggleSelected = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

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
              setEditing(false);
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
        <aside className="repos-explorer" aria-label="Explorer">
          <p className="repos-pane-title">Files</p>
          <ul className="repos-tree">
            {rootListing === undefined ? (
              <li className="repos-hint">Loading…</li>
            ) : rootListing.entries.length === 0 ? (
              <li className="repos-hint">Empty folder.</li>
            ) : (
              <TreeLevel
                listing={rootListing}
                depth={0}
                listings={listings}
                expandedDirs={expandedDirs}
                openFilePath={file?.path}
                onToggleDir={toggleDir}
                onOpenFile={openFile}
              />
            )}
          </ul>

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
            onOpenDiff={(path) => repo !== undefined && openDiff(repo.root, path)}
            onOpenFile={(path) => repo !== undefined && openFile(childPath(repo.root, path))}
            onToggleSelected={toggleSelected}
            onContextMenu={(target) => setMenu(target)}
            onStage={(paths) => repo !== undefined && runWrite(() => client.gitStage(repo.root, paths))}
            onUnstage={(paths) => repo !== undefined && runWrite(() => client.gitUnstage(repo.root, paths))}
            onCommit={() =>
              repo !== undefined && runWrite(() => client.gitCommit(repo.root, commitMessage.trim()))
            }
            onPush={() =>
              repo !== undefined &&
              runWrite(() => client.gitPush(repo.root), `Push ${repo.branch ?? "this branch"} to its remote?`)
            }
            onPull={() =>
              repo !== undefined &&
              runWrite(
                () => client.gitPull(repo.root),
                `Pull (fast-forward only) into ${repo.branch ?? "this branch"}?`
              )
            }
            onCheckout={(name, create) =>
              repo !== undefined &&
              runWrite(
                () => client.gitCheckout(repo.root, name, create),
                repo.clean
                  ? undefined
                  : `Switch to "${name}" with uncommitted changes? Your changes will follow if they don't conflict.`
              )
            }
            onDiscardFile={(target) =>
              repo !== undefined &&
              runWrite(
                () => client.gitDiscard(repo.root, [target.path], target.untracked),
                `Discard changes to ${target.path}? This cannot be undone.`
              )
            }
          />
        </aside>

        <div className="repos-viewer">
          {viewerMode === "diff" ? (
            <DiffPane diff={diff} />
          ) : (
            <FilePane
              file={file}
              loading={fileLoading}
              error={error}
              editing={editing}
              draft={draft}
              saving={saving}
              saveError={saveError}
              onEdit={startEditing}
              onDraft={setDraft}
              onSave={saveDraft}
              onCancel={() => {
                setEditing(false);
                setSaveError(undefined);
              }}
            />
          )}
        </div>
      </div>

      {menu !== undefined && (
        <RepoContextMenu
          target={menu}
          onClose={() => setMenu(undefined)}
          onOpenDiff={(path) => repo !== undefined && openDiff(repo.root, path)}
          onOpenFile={(path) => repo !== undefined && openFile(childPath(repo.root, path))}
          onStage={(paths) => repo !== undefined && runWrite(() => client.gitStage(repo.root, paths))}
          onUnstage={(paths) => repo !== undefined && runWrite(() => client.gitUnstage(repo.root, paths))}
          onDiscard={(target) =>
            repo !== undefined &&
            runWrite(
              () => client.gitDiscard(repo.root, [target.path], target.untracked),
              `Discard changes to ${target.path}? This cannot be undone.`
            )
          }
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
                {isDir ? (isOpen ? "▾" : "▸") : "·"}
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
  const grouped = useMemo(() => (repo === undefined ? undefined : groupFiles(repo.files)), [repo]);
  const canCommit =
    grouped !== undefined && grouped.staged.length > 0 && commitMessage.trim().length > 0 && !busy;
  const selectedList = [...selected];

  return (
    <div className="repos-scm" aria-label="Source control">
      <div className="repos-scm-head">
        <p className="repos-pane-title">Source control</p>
        {repos.length > 1 && (
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
        )}
      </div>

      {repo === undefined ? (
        <p className="repos-hint">No git repository in this folder.</p>
      ) : (
        <>
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
                {(branches?.branches ?? (repo.branch === undefined ? [] : [repo.branch])).map((name) => (
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

          {repo.clean ? (
            <p className="repos-hint">Working tree clean.</p>
          ) : (
            <div className="repos-changes">
              {grouped !== undefined && grouped.staged.length > 0 && (
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
              {grouped !== undefined && grouped.unstaged.length > 0 && (
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
                  placeholder={
                    grouped !== undefined && grouped.staged.length === 0
                      ? "Stage changes to commit…"
                      : "Commit message…"
                  }
                  rows={2}
                  onChange={(event) => onCommitMessage(event.target.value)}
                />
                <button type="button" className="git-commit-button" onClick={onCommit} disabled={!canCommit}>
                  Commit{" "}
                  {grouped !== undefined && grouped.staged.length > 0 ? `(${grouped.staged.length})` : ""}
                </button>
              </div>
            </div>
          )}
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
  editing: boolean;
  draft: string;
  saving: boolean;
  saveError: string | undefined;
  onEdit: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The center pane's file view: syntax-highlighted read mode, or an in-place editor
    whose Save crosses the bridge's `write_file` boundary (ADR-0097). */
function FilePane({
  file,
  loading,
  error,
  editing,
  draft,
  saving,
  saveError,
  onEdit,
  onDraft,
  onSave,
  onCancel
}: Readonly<FilePaneProps>): ReactElement {
  const rendered = useMemo(() => {
    if (file === undefined || editing) {
      return undefined;
    }
    if (isMarkdownFile(file.path)) {
      return { kind: "markdown" as const, html: renderMarkdown(file.content) };
    }
    return { kind: "code" as const, html: highlightSource(file.content, file.path) };
  }, [file, editing]);

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
    return <div className="file-viewer empty">Select a file to view or edit its source.</div>;
  }

  const dirty = editing && draft !== file.content;

  return (
    <div className="file-viewer">
      <header className="file-viewer-head">
        <span className="file-viewer-name">
          {basename(file.path)}
          {dirty ? " •" : ""}
        </span>
        <span className="file-viewer-actions">
          {editing ? (
            <>
              <button type="button" className="git-link" onClick={onSave} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="git-link" onClick={onCancel} disabled={saving}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="file-viewer-meta">{file.truncated ? "truncated (too large to edit)" : ""}</span>
              <button type="button" className="git-link" onClick={onEdit} disabled={file.truncated}>
                Edit
              </button>
            </>
          )}
        </span>
      </header>

      {saveError !== undefined && (
        <p role="alert" className="settings-error">
          {saveError}
        </p>
      )}

      {editing ? (
        <textarea
          className="repos-editor"
          aria-label={`Edit ${basename(file.path)}`}
          spellCheck={false}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
      ) : rendered?.kind === "markdown" ? (
        <article className="markdown-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      ) : (
        <pre className="code-view">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: rendered?.html ?? "" }} />
        </pre>
      )}
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
