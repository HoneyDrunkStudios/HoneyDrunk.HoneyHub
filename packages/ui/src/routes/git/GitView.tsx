import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { GitDiff, GitStatus } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { diffStat, toDiffLines } from "./gitModel";

export interface GitViewProps {
  client: WireClient;
  active: boolean;
  /** Allowlisted workspace roots to pick a repo from. */
  workspaceRoots: string[];
}

/**
 * Git (parity polish #9): a read-only view of a workspace's branch / ahead-behind / dirty
 * files and a unified diff. The bridge shells out to `git status` / `git diff HEAD`
 * (allowlist-gated); nothing here mutates the repo. Pick a repo, see what changed, click a
 * file to read its diff (or view the whole-repo diff).
 */
export function GitView({ client, active, workspaceRoots }: Readonly<GitViewProps>): ReactElement {
  const [root, setRoot] = useState<string>(workspaceRoots[0] ?? "");
  const [status, setStatus] = useState<GitStatus | undefined>(undefined);
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  // Follow the first root if the picker has none chosen yet.
  useEffect(() => {
    if (root === "" && workspaceRoots.length > 0) {
      setRoot(workspaceRoots[0]!);
    }
  }, [root, workspaceRoots]);

  const refresh = useCallback(() => {
    if (root === "") {
      return;
    }
    setLoading(true);
    setError(undefined);
    setDiff(undefined);
    client.gitStatus(root).catch(() => {
      setError("could not read git status");
      setLoading(false);
    });
  }, [client, root]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "git_status") {
        setStatus(event.payload.status);
        setLoading(false);
      } else if (event.payload.kind === "git_diff") {
        setDiff(event.payload.diff);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active && root !== "") {
      refresh();
    }
  }, [active, root, refresh]);

  const openDiff = (path?: string) => {
    setError(undefined);
    client.gitDiff(root, path).catch(() => setError("could not read the diff"));
  };

  const stat = useMemo(() => (diff === undefined ? undefined : diffStat(diff.patch)), [diff]);
  const diffLines = useMemo(() => (diff === undefined ? [] : toDiffLines(diff.patch)), [diff]);

  if (workspaceRoots.length === 0) {
    return (
      <section className="git" aria-label="Git">
        <header className="git-header">
          <h2>Git</h2>
        </header>
        <p className="git-empty">
          Add a workspace in Settings to see its branch, changes, and diffs.
        </p>
      </section>
    );
  }

  return (
    <section className="git" aria-label="Git">
      <header className="git-header">
        <h2>Git</h2>
        <div className="git-actions">
          <select aria-label="Repository" value={root} onChange={(event) => setRoot(event.target.value)}>
            {workspaceRoots.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </header>

      {error !== undefined && (
        <p role="alert" className="git-error">
          {error}
        </p>
      )}

      {status !== undefined && (
        <div className="git-summary">
          <span className="git-branch">{status.branch ?? "(detached)"}</span>
          {status.upstream !== undefined && <span className="git-upstream">→ {status.upstream}</span>}
          {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          <span className={status.clean ? "git-clean" : "git-dirty"}>
            {status.clean ? "clean" : `${status.files.length} changed`}
          </span>
          {!status.clean && (
            <button type="button" className="git-diff-all" onClick={() => openDiff()}>
              View all changes
            </button>
          )}
        </div>
      )}

      {status !== undefined && !status.clean && (
        <ul className="git-files">
          {status.files.map((file) => (
            <li key={file.path}>
              <button type="button" className="git-file" onClick={() => openDiff(file.path)}>
                <span className={`git-code code-${file.untracked ? "untracked" : file.staged ? "staged" : "dirty"}`}>
                  {file.status}
                </span>
                <span className="git-path">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {diff !== undefined && (
        <div className="git-diff">
          <div className="git-diff-head">
            <span className="git-diff-path">{diff.path ?? "All changes"}</span>
            {stat !== undefined && (
              <span className="git-diff-stat">
                <span className="stat-add">+{stat.added}</span>{" "}
                <span className="stat-del">-{stat.removed}</span>
              </span>
            )}
          </div>
          {diff.patch.trim().length === 0 ? (
            <p className="git-empty">No diff (the change may be untracked or staged only).</p>
          ) : (
            <pre className="diff-view" aria-label="Diff">
              {diffLines.map((line, index) => (
                <span key={index} className={`diff-line diff-${line.kind}`}>
                  {line.text}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
          {diff.truncated && <p className="git-truncated">Diff truncated (very large change).</p>}
        </div>
      )}
    </section>
  );
}
