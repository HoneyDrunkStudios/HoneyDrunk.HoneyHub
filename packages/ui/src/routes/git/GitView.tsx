import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type {
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
import { diffStat, groupFiles, replaceRepoStatus, toDiffLines } from "./gitModel";

export interface GitViewProps {
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

/**
 * Git: a multi-repo working-tree client. Pick a workspace folder and the bridge discovers
 * every repo inside it (or just the one when the folder is itself a repo), showing each
 * repo's branch, ahead/behind, and change count. Expand a repo to stage/unstage, commit,
 * push, pull, switch/create branches, discard changes, and read diffs. Reads are free;
 * every write is confirmation-gated (a scoped exception to the bridge's read-only posture,
 * ADR-0090 D9 / ADR-0094 D5 precedent).
 */
export function GitView({
  client,
  active,
  workspaceRoots,
  defaultWorkspaceRoot
}: Readonly<GitViewProps>): ReactElement {
  const [folder, setFolder] = useState<string>(() =>
    resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot)
  );
  const [overview, setOverview] = useState<GitOverview | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Expanded-repo-scoped state (only one repo is expanded at a time).
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<GitBranches | undefined>(undefined);
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [feedback, setFeedback] = useState<GitOpResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | undefined>(undefined);

  // Follow the resolved default until the user picks a folder.
  useEffect(() => {
    if (folder === "" && workspaceRoots.length > 0) {
      setFolder(resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot));
    }
  }, [folder, workspaceRoots, defaultWorkspaceRoot]);

  const refresh = useCallback(() => {
    if (folder === "") {
      return;
    }
    setLoading(true);
    setError(undefined);
    client.gitOverview(folder).catch(() => {
      setError("could not read git status");
      setLoading(false);
    });
  }, [client, folder]);

  // Latest refresh + folder/active, so the [client]-only event subscription can react to
  // host-pushed fs_changed without re-subscribing.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const activeRef = useRef(active);
  activeRef.current = active;
  // The (root, path) of the diff this view last requested, so a diff opened in another
  // surface (Browse shares the same event bus) can't clobber ours.
  const pendingDiff = useRef<{ root: string; path?: string } | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "fs_changed") {
        // A file changed on disk under this folder — refresh the overview (silently; the
        // git_overview event just replaces the data).
        if (
          activeRef.current &&
          folderRef.current !== "" &&
          payload.paths.some((path) => isWithin(path, folderRef.current))
        ) {
          refreshRef.current();
        }
      } else if (payload.kind === "git_overview") {
        // Both Git and Browse subscribe to this device-wide event; only take the overview
        // for the folder this view is showing.
        if (payload.overview.root === folderRef.current) {
          setOverview(payload.overview);
          setLoading(false);
        }
      } else if (payload.kind === "git_status") {
        // A write re-emits one repo's fresh status — merge it into the overview.
        setOverview((prev) => (prev === undefined ? prev : replaceRepoStatus(prev, payload.status)));
      } else if (payload.kind === "git_branches") {
        setBranches(payload.branches);
      } else if (payload.kind === "git_diff") {
        // Only accept the diff we asked for (the event bus is shared with Browse).
        const want = pendingDiff.current;
        if (want !== undefined && payload.diff.root === want.root && payload.diff.path === want.path) {
          setDiff(payload.diff);
        }
      } else if (payload.kind === "git_op") {
        setFeedback(payload.result);
        setBusy(false);
        // A successful commit clears the message box.
        if (payload.result.ok && payload.result.op === "commit") {
          setCommitMessage("");
        }
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active && folder !== "") {
      refresh();
    }
  }, [active, folder, refresh]);

  // Expand/collapse a repo, loading its branches and resetting per-repo state.
  const toggleRepo = (root: string) => {
    if (expanded === root) {
      setExpanded(undefined);
      return;
    }
    setExpanded(root);
    setBranches(undefined);
    setDiff(undefined);
    setCommitMessage("");
    setNewBranch("");
    setFeedback(undefined);
    client.gitBranches(root).catch(() => undefined);
  };

  const openDiff = (root: string, path?: string) => {
    setDiff(undefined);
    setError(undefined);
    pendingDiff.current = path === undefined ? { root } : { root, path };
    client.gitDiff(root, path).catch(() => setError("could not read the diff"));
  };

  // Run a write op: mark busy + clear stale feedback; the git_op event clears busy. Reads
  // back through the same subscription. `confirmMessage`, when set, gates behind a modal.
  const runWrite = (op: () => Promise<void>, confirmMessage?: string) => {
    const fire = () => {
      setBusy(true);
      setFeedback(undefined);
      op().catch(() => setBusy(false));
    };
    if (confirmMessage !== undefined) {
      setConfirm({ message: confirmMessage, action: fire });
    } else {
      fire();
    }
  };

  if (workspaceRoots.length === 0) {
    return (
      <section className="git" aria-label="Git">
        <header className="git-header">
          <h2>Git</h2>
        </header>
        <p className="git-empty">Add a workspace in Settings to see its repos, changes, and diffs.</p>
      </section>
    );
  }

  return (
    <section className="git" aria-label="Git">
      <header className="git-header">
        <h2>Git</h2>
        <div className="git-actions">
          <select
            aria-label="Workspace folder"
            value={folder}
            onChange={(event) => {
              setFolder(event.target.value);
              setExpanded(undefined);
              setOverview(undefined);
            }}
          >
            {workspaceRoots.map((option) => (
              <option key={option} value={option}>
                {basename(option)}
              </option>
            ))}
          </select>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
          <span className="live-dot" title="Live: updates when files change on disk" aria-hidden="true" />
        </div>
      </header>

      {error !== undefined && (
        <p role="alert" className="git-error">
          {error}
        </p>
      )}

      {overview !== undefined && overview.repos.length === 0 && (
        <p className="git-empty">No git repositories found in this folder.</p>
      )}

      <ul className="git-repos" aria-label="Repositories">
        {overview?.repos.map((repo) => (
          <li key={repo.root} className="git-repo">
            <RepoSummary repo={repo} expanded={expanded === repo.root} onToggle={() => toggleRepo(repo.root)} />
            {expanded === repo.root && (
              <RepoDetail
                repo={repo}
                branches={branches}
                diff={diff}
                commitMessage={commitMessage}
                onCommitMessage={setCommitMessage}
                newBranch={newBranch}
                onNewBranch={setNewBranch}
                feedback={feedback}
                busy={busy}
                onStage={(paths) => runWrite(() => client.gitStage(repo.root, paths))}
                onUnstage={(paths) => runWrite(() => client.gitUnstage(repo.root, paths))}
                onCommit={() => runWrite(() => client.gitCommit(repo.root, commitMessage.trim()))}
                onPush={() =>
                  runWrite(() => client.gitPush(repo.root), `Push ${repo.branch ?? "this branch"} to its remote?`)
                }
                onPull={() =>
                  runWrite(() => client.gitPull(repo.root), `Pull (fast-forward only) into ${repo.branch ?? "this branch"}?`)
                }
                onCheckout={(name, create) =>
                  runWrite(
                    () => client.gitCheckout(repo.root, name, create),
                    repo.clean
                      ? undefined
                      : `Switch to "${name}" with uncommitted changes? Your changes will follow if they don't conflict.`
                  )
                }
                onDeleteBranch={(name) =>
                  runWrite(
                    () => client.gitDeleteBranch(repo.root, name),
                    `Delete branch "${name}"? (Unmerged commits would be lost.)`
                  )
                }
                onDiscardFile={(file) =>
                  runWrite(
                    () => client.gitDiscard(repo.root, [file.path], file.untracked),
                    `Discard changes to ${file.path}? This cannot be undone.`
                  )
                }
                onDiscardAll={() =>
                  runWrite(
                    () => client.gitDiscardAll(repo.root),
                    `Discard ALL changes in ${basename(repo.root)}? Every uncommitted edit and untracked file will be removed. This cannot be undone.`
                  )
                }
                onOpenDiff={(path) => openDiff(repo.root, path)}
              />
            )}
          </li>
        ))}
      </ul>

      {confirm !== undefined && (
        <div className="git-confirm-backdrop" role="dialog" aria-label="Confirm action">
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
        </div>
      )}
    </section>
  );
}

/** The collapsed/summary row for a repo: name, branch, ahead/behind, change count. */
function RepoSummary({
  repo,
  expanded,
  onToggle
}: Readonly<{ repo: GitStatus; expanded: boolean; onToggle: () => void }>): ReactElement {
  return (
    <button type="button" className="git-repo-summary" aria-expanded={expanded} onClick={onToggle}>
      <span className="git-repo-caret" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
      <span className="git-repo-name">{basename(repo.root)}</span>
      <span className="git-branch">{repo.branch ?? "(detached)"}</span>
      {repo.ahead > 0 && <span className="git-ahead">↑{repo.ahead}</span>}
      {repo.behind > 0 && <span className="git-behind">↓{repo.behind}</span>}
      <span className={repo.clean ? "git-clean" : "git-dirty"}>
        {repo.clean ? "clean" : `${repo.files.length} changed`}
      </span>
    </button>
  );
}

interface RepoDetailProps {
  repo: GitStatus;
  branches: GitBranches | undefined;
  diff: GitDiff | undefined;
  commitMessage: string;
  onCommitMessage: (value: string) => void;
  newBranch: string;
  onNewBranch: (value: string) => void;
  feedback: GitOpResult | undefined;
  busy: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onCheckout: (name: string, create: boolean) => void;
  onDeleteBranch: (name: string) => void;
  onDiscardFile: (file: GitFileStatus) => void;
  onDiscardAll: () => void;
  onOpenDiff: (path?: string) => void;
}

/** The expanded repo panel: branch controls, pull/push, staged/unstaged files with
    stage/unstage/discard/diff, the commit box, and a diff viewer. */
function RepoDetail({
  repo,
  branches,
  diff,
  commitMessage,
  onCommitMessage,
  newBranch,
  onNewBranch,
  feedback,
  busy,
  onStage,
  onUnstage,
  onCommit,
  onPush,
  onPull,
  onCheckout,
  onDeleteBranch,
  onDiscardFile,
  onDiscardAll,
  onOpenDiff
}: Readonly<RepoDetailProps>): ReactElement {
  const grouped = useMemo(() => groupFiles(repo.files), [repo.files]);
  const canCommit = grouped.staged.length > 0 && commitMessage.trim().length > 0 && !busy;
  const otherBranches = (branches?.branches ?? []).filter((name) => name !== repo.branch);

  return (
    <div className="git-detail">
      <div className="git-detail-bar">
        <label className="git-branch-switch">
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
          className="git-new-branch"
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
        {otherBranches.length > 0 && (
          <label className="git-delete-branch">
            <span className="visually-hidden">Delete branch</span>
            <select
              aria-label="Delete branch"
              value=""
              disabled={busy}
              onChange={(event) => {
                if (event.target.value !== "") {
                  onDeleteBranch(event.target.value);
                  event.target.value = "";
                }
              }}
            >
              <option value="">Delete branch…</option>
              {otherBranches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="git-remote-actions">
          <button type="button" onClick={onPull} disabled={busy}>
            Pull{repo.behind > 0 ? ` ↓${repo.behind}` : ""}
          </button>
          <button type="button" onClick={onPush} disabled={busy}>
            Push{repo.ahead > 0 ? ` ↑${repo.ahead}` : ""}
          </button>
          <button type="button" onClick={() => onOpenDiff()} disabled={repo.clean}>
            View all changes
          </button>
          <button
            type="button"
            className="git-link git-discard"
            onClick={onDiscardAll}
            disabled={busy || repo.clean}
          >
            Discard all
          </button>
        </div>
      </div>

      {feedback !== undefined && (
        <p className={`git-feedback ${feedback.ok ? "is-ok" : "is-error"}`} role="status">
          {feedback.message ?? (feedback.ok ? `${feedback.op} ok` : `${feedback.op} failed`)}
        </p>
      )}

      {repo.clean ? (
        <p className="git-empty">Working tree clean.</p>
      ) : (
        <div className="git-changes">
          <FileGroup
            title="Staged"
            files={grouped.staged}
            action="Unstage"
            onAction={(file) => onUnstage([file.path])}
            onActionAll={() => onUnstage(["."])}
            allLabel="Unstage all"
            onDiscard={onDiscardFile}
            onOpenDiff={onOpenDiff}
            busy={busy}
          />
          <FileGroup
            title="Changes"
            files={grouped.unstaged}
            action="Stage"
            onAction={(file) => onStage([file.path])}
            onActionAll={() => onStage(["."])}
            allLabel="Stage all"
            onDiscard={onDiscardFile}
            onOpenDiff={onOpenDiff}
            busy={busy}
          />
          <div className="git-commit">
            <textarea
              aria-label="Commit message"
              value={commitMessage}
              placeholder={
                grouped.staged.length === 0 ? "Stage changes to commit…" : "Commit message…"
              }
              rows={2}
              onChange={(event) => onCommitMessage(event.target.value)}
            />
            <button type="button" className="git-commit-button" onClick={onCommit} disabled={!canCommit}>
              Commit {grouped.staged.length > 0 ? `(${grouped.staged.length})` : ""}
            </button>
          </div>
        </div>
      )}

      {diff !== undefined && diff.root === repo.root && <DiffViewer diff={diff} />}
    </div>
  );
}

interface FileGroupProps {
  title: string;
  files: GitFileStatus[];
  action: string;
  onAction: (file: GitFileStatus) => void;
  onActionAll: () => void;
  allLabel: string;
  onDiscard: (file: GitFileStatus) => void;
  onOpenDiff: (path: string) => void;
  busy: boolean;
}

function FileGroup({
  title,
  files,
  action,
  onAction,
  onActionAll,
  allLabel,
  onDiscard,
  onOpenDiff,
  busy
}: Readonly<FileGroupProps>): ReactNode {
  if (files.length === 0) {
    return null;
  }
  return (
    <div className="git-file-group">
      <div className="git-file-group-head">
        <span className="git-file-group-title">
          {title} <span className="git-file-count">{files.length}</span>
        </span>
        <button type="button" className="git-link" onClick={onActionAll} disabled={busy}>
          {allLabel}
        </button>
      </div>
      <ul className="git-files">
        {files.map((file) => {
          const codeKind = file.untracked ? "untracked" : file.staged ? "staged" : "dirty";
          return (
            <li key={file.path} className="git-file-row">
              <button type="button" className="git-file" onClick={() => onOpenDiff(file.path)}>
                <span className={`git-code code-${codeKind}`}>{file.status}</span>
                <span className="git-path">{file.path}</span>
              </button>
              <div className="git-file-actions">
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

function DiffViewer({ diff }: Readonly<{ diff: GitDiff }>): ReactElement {
  const stat = useMemo(() => diffStat(diff.patch), [diff.patch]);
  const diffLines = useMemo(() => toDiffLines(diff.patch), [diff.patch]);
  const diffKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return diffLines.map((line) => {
      const base = `${line.kind}:${line.text}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { key: `${base}#${occurrence}`, line };
    });
  }, [diffLines]);

  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-path">{diff.path ?? "All changes"}</span>
        <span className="git-diff-stat">
          <span className="stat-add">+{stat.added}</span> <span className="stat-del">-{stat.removed}</span>
        </span>
      </div>
      {diff.patch.trim().length === 0 ? (
        <p className="git-empty">No diff (the change may be untracked or staged only).</p>
      ) : (
        <pre className="diff-view" aria-label="Diff">
          {diffKeys.map(({ key, line }) => (
            <span key={key} className={`diff-line diff-${line.kind}`}>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {diff.truncated && <p className="git-truncated">Diff truncated (very large change).</p>}
    </div>
  );
}
