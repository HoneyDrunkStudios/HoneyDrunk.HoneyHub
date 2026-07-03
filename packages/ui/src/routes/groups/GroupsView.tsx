import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { GitDiff, GitOverview } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import type { RunSummary } from "../runs/runsModel";
import { isRunActive } from "../runs/runsModel";
import { basename, isWithin } from "../../paths";
import { diffStat, toDiffLines } from "../git/gitModel";
import {
  groupByBranch,
  isInterestingGroup,
  mergeOverviews,
  orderGroups,
  type ChangeGroup,
  type GroupRepo
} from "./groupsModel";
import {
  applyCheckOutcome,
  checkIdFor,
  KNOWN_CHECK_IDS,
  loadCheckIds,
  saveCheckIds,
  setCheckId,
  startCheck,
  summarizeChecks,
  type CheckState,
  type ChecksState
} from "./checksModel";

export interface GroupsViewProps {
  client: WireClient;
  active: boolean;
  /** Allowlisted workspace roots (folders or single repos) to scan. The Groups surface
      spans ALL of them, so a change living across separately-added repos still groups. */
  workspaceRoots: string[];
  /** The live runs board, so each group can show the agent runs working inside it. */
  runs: RunSummary[];
}

/**
 * Groups: the cross-repo change board. It scans every workspace root, clusters each repo /
 * worktree by its checked-out branch, and shows a shared-branch change (e.g. an API + its
 * web app on `claude/feature-x`) as ONE group — combined file count, dirty/ahead/behind
 * rollup, the agent runs working inside it, and a combined diff across all member repos.
 *
 * It reuses the read-only git data the Git screen already fetches (`git_overview` per root,
 * `git_diff` per repo); nothing here writes, so it stays inside the bridge's read posture.
 */
export function GroupsView({
  client,
  active,
  workspaceRoots,
  runs
}: Readonly<GroupsViewProps>): ReactElement {
  // One overview per workspace root, keyed by the root it was requested for (the event
  // echoes `overview.root`), so re-scanning a root replaces just its slice.
  const [overviews, setOverviews] = useState<Record<string, GitOverview>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  // The combined diff for the expanded group: one patch per member repo root.
  const [diffs, setDiffs] = useState<Record<string, GitDiff>>({});
  // Live check runs keyed by repo root, and the user's per-repo check picks (persisted).
  const [checks, setChecks] = useState<ChecksState>({});
  const [picks, setPicks] = useState<Record<string, string>>(() => loadCheckIds());

  const refresh = useCallback(() => {
    if (workspaceRoots.length === 0) {
      return;
    }
    setLoading(true);
    setError(undefined);
    for (const root of workspaceRoots) {
      client.gitOverview(root).catch(() => {
        setError("could not read git status");
        setLoading(false);
      });
    }
  }, [client, workspaceRoots]);

  // Latest refresh + active, so the [client]-only subscription can react to host-pushed
  // fs_changed without re-subscribing.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const activeRef = useRef(active);
  activeRef.current = active;
  const rootsRef = useRef(workspaceRoots);
  rootsRef.current = workspaceRoots;

  // When the operator edits the workspace-roots setting, prune state that belonged to
  // removed roots — otherwise stale groups stay visible (and runnable) until reload.
  // Overviews are keyed by the workspace root itself; diffs/checks by repo roots UNDER one.
  useEffect(() => {
    const keepRepo = (path: string) => workspaceRoots.some((root) => isWithin(path, root));
    setOverviews((prev) => pruneKeys(prev, (root) => workspaceRoots.includes(root)));
    setDiffs((prev) => pruneKeys(prev, keepRepo));
    setChecks((prev) => pruneKeys(prev, keepRepo));
  }, [workspaceRoots]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "git_overview") {
        const next = payload.overview;
        setOverviews((prev) => ({ ...prev, [next.root]: next }));
        setLoading(false);
      } else if (payload.kind === "git_diff") {
        // Collect whole-repo diffs (no path) for the combined view; ignore single-file
        // diffs opened elsewhere on the shared bus.
        const diff = payload.diff;
        if (diff.path === undefined) {
          setDiffs((prev) => ({ ...prev, [diff.root]: diff }));
        }
      } else if (payload.kind === "check_result") {
        // The overlap-vs-terminal folding rule lives in applyCheckOutcome.
        setChecks((prev) => applyCheckOutcome(prev, payload.result));
      } else if (payload.kind === "fs_changed") {
        // A file changed under one of our roots → re-scan (silent refresh).
        if (activeRef.current && touchesRoots(payload.paths, rootsRef.current)) {
          refreshRef.current();
        }
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active && workspaceRoots.length > 0) {
      refresh();
    }
  }, [active, workspaceRoots, refresh]);

  const groups = useMemo(() => {
    const merged = mergeOverviews(Object.values(overviews));
    return orderGroups(groupByBranch(merged, runs));
  }, [overviews, runs]);

  const interesting = useMemo(() => groups.filter(isInterestingGroup), [groups]);
  const visible = showAll ? groups : interesting;
  // Independent of showAll, so the toggle stays available after "Show N baseline"
  // (otherwise "Hide baseline" would disappear the moment everything is visible).
  const baselineCount = groups.length - interesting.length;

  // Expand a group → request a whole-repo diff for each member so the combined view fills in.
  const toggleGroup = (group: ChangeGroup) => {
    if (expanded === group.branch) {
      setExpanded(undefined);
      return;
    }
    setExpanded(group.branch);
    setDiffs({});
    for (const member of group.repos) {
      if (!member.status.clean) {
        client.gitDiff(member.status.root).catch(() => undefined);
      }
    }
  };

  // Persist a repo's picked check as the user changes it (the default clears the pick).
  const onCheckChange = (root: string, checkId: string) => {
    setPicks((prev) => {
      const next = setCheckId(prev, root, checkId);
      saveCheckIds(next);
      return next;
    });
  };

  // Run every member repo's picked named check — the "test the group" action. Each is
  // marked running immediately; the bridge answers with a `check_result` per repo.
  // Repos already running are skipped (the host would refuse the overlap anyway; the
  // client-side skip keeps the denial from clobbering the live running state).
  const runChecks = (group: ChangeGroup) => {
    for (const member of group.repos) {
      const root = member.status.root;
      if (checks[root]?.phase === "running") {
        continue;
      }
      const checkId = checkIdFor(picks, root);
      setChecks((prev) => startCheck(prev, { root, command: checkId }));
      client.runCheck(root, checkId).catch((error: unknown) =>
        setChecks((prev) =>
          applyCheckOutcome(prev, {
            root,
            check: checkId,
            command: checkId,
            ok: false,
            // A dispatch rejection means the request never reached the runner (dead
            // socket, allowlist refusal) — surface the transport reason, not a fake
            // spawn failure.
            disposition: "denied",
            output:
              error instanceof Error && error.message.length > 0
                ? `could not start the check: ${error.message}`
                : "could not start the check",
            truncated: false
          })
        )
      );
    }
  };

  if (workspaceRoots.length === 0) {
    return (
      <section className="groups" aria-label="Groups">
        <header className="groups-header">
          <h2>Groups</h2>
        </header>
        <p className="groups-empty">
          Add a workspace in Settings to group related changes across your repos and
          worktrees by branch.
        </p>
      </section>
    );
  }

  return (
    <section className="groups" aria-label="Groups">
      <header className="groups-header">
        <div>
          <p className="eyebrow">Groups</p>
          <h2>Change groups</h2>
        </div>
        <div className="groups-actions">
          {baselineCount > 0 && (
            <button type="button" className="git-link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide baseline" : `Show ${baselineCount} baseline`}
            </button>
          )}
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
          <span className="live-dot" title="Live: updates when files change on disk" aria-hidden="true" />
        </div>
      </header>

      {error !== undefined && (
        <p role="alert" className="groups-error">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="groups-empty">
          No grouped changes yet. Start work in worktrees that share a branch name (e.g.{" "}
          <code>claude/feature-x</code>) across repos and they&apos;ll cluster here.
        </p>
      ) : (
        <ul className="groups-list" aria-label="Group list">
          {visible.map((group) => (
            <li key={group.branch} className="group-row">
              <GroupSummary
                group={group}
                expanded={expanded === group.branch}
                onToggle={() => toggleGroup(group)}
              />
              {expanded === group.branch && (
                <GroupDetail
                  group={group}
                  diffs={diffs}
                  checks={checks}
                  picks={picks}
                  onCheckChange={onCheckChange}
                  onRunChecks={() => runChecks(group)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** True when any changed path lands inside one of the scanned workspace roots. */
function touchesRoots(paths: string[], roots: string[]): boolean {
  return paths.some((path) => roots.some((root) => isWithin(path, root)));
}

/** Drop entries whose key fails `keep`, returning the SAME reference when nothing was
    dropped (so the state updaters it feeds skip a re-render). */
function pruneKeys<T>(map: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
  const stale = Object.keys(map).filter((key) => !keep(key));
  if (stale.length === 0) {
    return map;
  }
  const next = { ...map };
  for (const key of stale) {
    delete next[key];
  }
  return next;
}

/** The collapsed group row: branch, member-repo count, combined changes, run/ahead/behind. */
function GroupSummary({
  group,
  expanded,
  onToggle
}: Readonly<{ group: ChangeGroup; expanded: boolean; onToggle: () => void }>): ReactElement {
  return (
    <button type="button" className="group-summary" aria-expanded={expanded} onClick={onToggle}>
      <span className="group-caret" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
      <span className="group-branch">{group.branch}</span>
      <span className="group-repos">
        {group.repos.length} repo{group.repos.length === 1 ? "" : "s"}
      </span>
      <span className={group.changedFiles > 0 ? "group-dirty" : "group-clean"}>
        {group.changedFiles > 0 ? `${group.changedFiles} changed` : "clean"}
      </span>
      {group.ahead > 0 && <span className="group-ahead">↑{group.ahead}</span>}
      {group.behind > 0 && <span className="group-behind">↓{group.behind}</span>}
      {group.activeRuns > 0 && (
        <span className="group-runs" title="active runs in this group">
          ▶ {group.activeRuns}
        </span>
      )}
    </button>
  );
}

interface GroupDetailProps {
  group: ChangeGroup;
  diffs: Record<string, GitDiff>;
  checks: ChecksState;
  picks: Record<string, string>;
  onCheckChange: (root: string, checkId: string) => void;
  onRunChecks: () => void;
}

/** The expanded group: a "run checks" bar, each member repo with its change count, attributed
    runs, picked named check + result, and the combined diff across all member repos. */
function GroupDetail({
  group,
  diffs,
  checks,
  picks,
  onCheckChange,
  onRunChecks
}: Readonly<GroupDetailProps>): ReactElement {
  const combinedStat = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const member of group.repos) {
      const diff = diffs[member.status.root];
      if (diff !== undefined) {
        const stat = diffStat(diff.patch);
        added += stat.added;
        removed += stat.removed;
      }
    }
    return { added, removed };
  }, [group.repos, diffs]);

  const checkStates = group.repos
    .map((member) => checks[member.status.root])
    .filter((state): state is CheckState => state !== undefined);
  const summary = summarizeChecks(checkStates);

  return (
    <div className="group-detail">
      <div className="group-checks-bar">
        <button
          type="button"
          className="group-run-checks"
          onClick={onRunChecks}
          disabled={summary.running > 0}
        >
          {summary.running > 0 ? "Running…" : "Run checks"}
        </button>
        {summary.total > 0 && (
          <output className="group-checks-summary" aria-label="Check summary">
            {summary.passed > 0 && <span className="checks-passed">{summary.passed} passed</span>}
            {summary.failed > 0 && <span className="checks-failed">{summary.failed} failed</span>}
            {summary.running > 0 && <span className="checks-running">{summary.running} running</span>}
          </output>
        )}
      </div>

      <div className="group-members">
        {group.repos.map((member) => (
          <GroupMember
            key={member.status.root}
            member={member}
            runs={group.runs.filter((run) => runInRepo(run, member.status.root))}
            checkId={checkIdFor(picks, member.status.root)}
            onCheckChange={(value) => onCheckChange(member.status.root, value)}
            check={checks[member.status.root]}
          />
        ))}
      </div>

      <div className="group-diff">
        <div className="group-diff-head">
          <span className="group-diff-title">Combined diff</span>
          <span className="group-diff-stat">
            <span className="stat-add">+{combinedStat.added}</span>{" "}
            <span className="stat-del">-{combinedStat.removed}</span>
          </span>
        </div>
        {group.repos
          .filter((member) => !member.status.clean)
          .map((member) => (
            <RepoDiff key={member.status.root} member={member} diff={diffs[member.status.root]} />
          ))}
      </div>
    </div>
  );
}

/** True when a run's launch workspace lands at/in a repo root (the per-member split of the
    group-level attribution). */
function runInRepo(run: RunSummary, repoRoot: string): boolean {
  const ws = run.workspaceRoot;
  if (ws === undefined || ws.length === 0) {
    return false;
  }
  return ws === repoRoot || isWithin(repoRoot, ws) || isWithin(ws, repoRoot);
}

interface GroupMemberProps {
  member: GroupRepo;
  runs: RunSummary[];
  checkId: string;
  onCheckChange: (checkId: string) => void;
  check: CheckState | undefined;
}

function GroupMember({
  member,
  runs,
  checkId,
  onCheckChange,
  check
}: Readonly<GroupMemberProps>): ReactElement {
  const name = basename(member.status.root);
  return (
    <div className="group-member">
      <span className="group-member-name">{name}</span>
      <span className={member.changedFiles > 0 ? "group-dirty" : "group-clean"}>
        {member.changedFiles > 0 ? `${member.changedFiles} changed` : "clean"}
      </span>
      {runs.length > 0 && (
        <ul className="group-member-runs" aria-label={`Runs in ${name}`}>
          {runs.map((run) => (
            <li key={run.runId} className={`group-member-run ${isRunActive(run) ? "is-active" : "is-done"}`}>
              <span className="group-run-dot" aria-hidden="true" />
              <span className="group-run-task" title={run.task}>
                {run.needsInput ? "needs input · " : ""}
                {run.task}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="group-member-check">
        {/* Named checks only: the option set mirrors the bridge's host-owned check
            IDS — the client never sends (or claims) a command line; what an id runs
            is host knowledge, echoed back on the outcome. */}
        <select
          className="group-check-command"
          aria-label={`Check for ${name}`}
          value={checkId}
          onChange={(event) => onCheckChange(event.target.value)}
        >
          {KNOWN_CHECK_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {check !== undefined && <CheckResultView check={check} />}
      </div>
    </div>
  );
}

/** The status-pill text for a check: running/passed, or failed with the exit code when known. */
function checkPhaseLabel(check: CheckState): string {
  if (check.phase === "running") {
    return "running…";
  }
  if (check.phase === "passed") {
    return "passed";
  }
  return check.exitCode === undefined ? "failed" : `failed (exit ${check.exitCode})`;
}

/** A member's check result: a phase pill and, once finished, a collapsible output block. */
function CheckResultView({ check }: Readonly<{ check: CheckState }>): ReactElement {
  return (
    <div className={`group-check-result phase-${check.phase}`}>
      {/* A plain span: the pill text is its own visible label, and 10 parallel checks
          flipping phases must not each become a live region shouting over the
          group-level summary (which IS an <output>). */}
      <span className="group-check-pill">{checkPhaseLabel(check)}</span>
      {check.output !== undefined && check.output.length > 0 && (
        <details className="group-check-output">
          <summary>output</summary>
          <pre>
            {check.output}
            {check.truncated === true ? "\n… (truncated)" : ""}
          </pre>
        </details>
      )}
    </div>
  );
}

function RepoDiff({
  member,
  diff
}: Readonly<{ member: GroupRepo; diff: GitDiff | undefined }>): ReactElement {
  const name = basename(member.status.root);
  const diffLines = useMemo(() => (diff === undefined ? [] : toDiffLines(diff.patch)), [diff]);
  const keys = useMemo(() => {
    const seen = new Map<string, number>();
    return diffLines.map((line) => {
      const base = `${line.kind}:${line.text}`;
      const occ = seen.get(base) ?? 0;
      seen.set(base, occ + 1);
      return { key: `${base}#${occ}`, line };
    });
  }, [diffLines]);

  let body: ReactElement;
  if (diff === undefined) {
    body = <p className="groups-loading">Loading diff…</p>;
  } else if (diff.patch.trim().length === 0) {
    body = <p className="groups-empty">No diff (changes may be untracked or staged only).</p>;
  } else {
    body = (
      <figure className="diff-figure" aria-label={`Diff for ${name}`}>
        <pre className="diff-view">
          {keys.map(({ key, line }) => (
            <span key={key} className={`diff-line diff-${line.kind}`}>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </figure>
    );
  }

  return (
    <div className="group-repo-diff">
      <p className="group-repo-diff-name">{name}</p>
      {body}
      {diff?.truncated === true && <p className="git-truncated">Diff truncated (very large change).</p>}
    </div>
  );
}
