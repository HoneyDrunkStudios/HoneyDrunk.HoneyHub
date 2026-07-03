import type { GitOverview, GitStatus } from "@honeydrunk/honeyhub-types";
import { isWithin } from "../../paths";
import { isRunActive, type RunSummary } from "../runs/runsModel";

// Change Groups: cluster the working-tree changes of many repos/worktrees by their shared
// branch name, so a cross-repo change (e.g. an API + its web app on the same feature
// branch) reads as ONE unit — combined diff stat, combined file count, and the agent runs
// working inside it. Pure + reducer-shaped (like runsModel/gitModel) so the same logic
// backs the view and is trivially testable.
//
// Why branch name is the key: the operator runs agents in per-repo worktrees that all sit
// on the same branch (the agent branch, e.g. `claude/feature-x`). The branch is the only
// signal already present on every repo's GitStatus that ties the worktrees together — no
// new bridge data is needed.

/** One repo/worktree's membership in a group, with its small +/- summary. We use the
    changed-file count (the GitStatus we already have) for the at-a-glance stat; a precise
    line stat needs the diff, which the view fetches lazily when a group is opened. */
export interface GroupRepo {
  status: GitStatus;
  changedFiles: number;
}

export interface ChangeGroup {
  /** The shared branch name that defines the group. */
  branch: string;
  /** Member repos/worktrees, in the order discovered. */
  repos: GroupRepo[];
  /** Total changed files across every member repo. */
  changedFiles: number;
  /** Repos with at least one uncommitted change. */
  dirtyRepos: number;
  /** Combined ahead/behind across members (how much is unpushed / unpulled overall). */
  ahead: number;
  behind: number;
  /** Agent runs attributed to this group (their launch workspace lands in a member repo). */
  runs: RunSummary[];
  /** Active (non-terminal) runs among `runs`. */
  activeRuns: number;
}

/** Merge several per-folder overviews into one repo list, de-duplicated by `root` (the
    Groups surface spans every workspace root, while a single `git_overview` covers one
    folder). Later entries win, so a fresher status replaces a stale one. */
export function mergeOverviews(overviews: readonly GitOverview[]): GitStatus[] {
  const byRoot = new Map<string, GitStatus>();
  for (const overview of overviews) {
    for (const repo of overview.repos) {
      byRoot.set(repo.root, repo);
    }
  }
  return [...byRoot.values()];
}

/** True when a run was launched inside (or at) a repo's root — either direction of
    containment, since a run's workspace may be the repo itself, a parent folder, or a
    nested path. A run with no known workspace never matches. */
function runTouchesRepo(run: RunSummary, repoRoot: string): boolean {
  const ws = run.workspaceRoot;
  if (ws === undefined || ws.length === 0) {
    return false;
  }
  return ws === repoRoot || isWithin(repoRoot, ws) || isWithin(ws, repoRoot);
}

/**
 * Group repos by their checked-out branch and attribute runs to each group. Repos with no
 * branch (detached HEAD) cannot be grouped by a shared branch, so they are omitted. A run
 * is attributed to a group when its launch workspace lands in any member repo; the same run
 * can appear in more than one group only if it spans repos on different branches (it won't
 * in normal use). Pure: no I/O, deterministic order (insertion order of first sighting).
 */
export function groupByBranch(
  repos: readonly GitStatus[],
  runs: readonly RunSummary[] = []
): ChangeGroup[] {
  const order: string[] = [];
  const byBranch = new Map<string, GitStatus[]>();
  for (const repo of repos) {
    if (repo.branch === undefined || repo.branch.length === 0) {
      continue; // detached / unknown — no shared-branch key to group on
    }
    const bucket = byBranch.get(repo.branch);
    if (bucket === undefined) {
      byBranch.set(repo.branch, [repo]);
      order.push(repo.branch);
    } else {
      bucket.push(repo);
    }
  }

  return order.map((branch) => {
    const members = byBranch.get(branch) ?? [];
    const groupRepos: GroupRepo[] = members.map((status) => ({
      status,
      changedFiles: status.files.length
    }));
    const attributed = runs.filter((run) =>
      members.some((repo) => runTouchesRepo(run, repo.root))
    );
    return {
      branch,
      repos: groupRepos,
      changedFiles: groupRepos.reduce((sum, repo) => sum + repo.changedFiles, 0),
      dirtyRepos: members.filter((repo) => !repo.clean).length,
      ahead: members.reduce((sum, repo) => sum + repo.ahead, 0),
      behind: members.reduce((sum, repo) => sum + repo.behind, 0),
      runs: attributed,
      activeRuns: attributed.filter(isRunActive).length
    };
  });
}

/** Branch names that are baselines rather than a unit of work — grouping these across
    repos is noise (everyone sits on `main`), so the view hides single-repo baseline groups
    by default. */
const BASELINE_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
  "trunk"
]);

/** A group is worth surfacing when it represents real cross-cutting work: it spans more
    than one repo/worktree, has uncommitted changes, has unpushed/unpulled commits, or has
    agent runs working in it. A lone, clean repo parked on a baseline branch is not. */
export function isInterestingGroup(group: ChangeGroup): boolean {
  if (group.repos.length > 1) {
    return true;
  }
  if (group.changedFiles > 0 || group.ahead > 0 || group.behind > 0) {
    return true;
  }
  if (group.runs.length > 0) {
    return true;
  }
  return false;
}

/** True only for a single-repo group sitting on a baseline branch with nothing going on —
    the kind `isInterestingGroup` filters out. Exposed so the view can count what it hid. */
export function isBaselineNoise(group: ChangeGroup): boolean {
  return (
    !isInterestingGroup(group) && BASELINE_BRANCHES.has(group.branch.toLowerCase())
  );
}

/** Rank groups for display: those with active runs first, then by most changed files, then
    most member repos, then branch name for a stable tiebreak. */
export function orderGroups(groups: readonly ChangeGroup[]): ChangeGroup[] {
  return [...groups].sort((a, b) => {
    const activeDelta = Number(b.activeRuns > 0) - Number(a.activeRuns > 0);
    if (activeDelta !== 0) {
      return activeDelta;
    }
    if (b.changedFiles !== a.changedFiles) {
      return b.changedFiles - a.changedFiles;
    }
    if (b.repos.length !== a.repos.length) {
      return b.repos.length - a.repos.length;
    }
    return a.branch < b.branch ? -1 : 1;
  });
}
