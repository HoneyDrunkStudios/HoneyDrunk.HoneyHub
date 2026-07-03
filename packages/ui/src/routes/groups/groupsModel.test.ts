import { describe, expect, it } from "vitest";
import type { GitFileStatus, GitOverview, GitStatus } from "@honeydrunk/honeyhub-types";
import type { RunSummary } from "../runs/runsModel";
import {
  groupByBranch,
  isBaselineNoise,
  isInterestingGroup,
  mergeOverviews,
  orderGroups
} from "./groupsModel";

function file(path: string): GitFileStatus {
  return { path, status: " M", staged: false, untracked: false };
}

function repo(
  root: string,
  branch: string | undefined,
  files: GitFileStatus[] = [],
  extra: Partial<GitStatus> = {}
): GitStatus {
  return {
    root,
    ...(branch === undefined ? {} : { branch }),
    ahead: 0,
    behind: 0,
    files,
    clean: files.length === 0,
    ...extra
  };
}

function run(runId: string, workspaceRoot: string | undefined, state = "running"): RunSummary {
  return {
    runId,
    sessionId: "s1",
    task: "do the thing",
    state: state as never,
    totalUsd: 0,
    totalTokens: 0,
    needsInput: false,
    artifacts: 0,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    updatedAt: "2026-06-27T00:00:00Z"
  };
}

describe("mergeOverviews", () => {
  it("de-dupes by root, last write winning, across folders", () => {
    const a: GitOverview = { root: "/ws/api", repos: [repo("/ws/api/svc", "feat", [file("x")])] };
    const b: GitOverview = { root: "/ws/web", repos: [repo("/ws/web/app", "feat")] };
    const stale: GitOverview = { root: "/ws/api", repos: [repo("/ws/api/svc", "feat", [])] };

    const merged = mergeOverviews([a, b, stale]);

    expect(merged).toHaveLength(2);
    // The later /ws/api/svc (clean) replaced the earlier dirty one.
    expect(merged.find((r) => r.root === "/ws/api/svc")?.clean).toBe(true);
    expect(merged.map((r) => r.root)).toContain("/ws/web/app");
  });
});

describe("groupByBranch", () => {
  it("clusters repos on the same branch into one group with combined stats", () => {
    const repos = [
      repo("/ws/api", "claude/feature-x", [file("a.ts"), file("b.ts")], { ahead: 1 }),
      repo("/ws/web", "claude/feature-x", [file("c.tsx")], { behind: 2 }),
      repo("/ws/docs", "main")
    ];

    const groups = groupByBranch(repos);

    const feature = groups.find((g) => g.branch === "claude/feature-x");
    expect(feature).toBeDefined();
    expect(feature?.repos).toHaveLength(2);
    expect(feature?.changedFiles).toBe(3);
    expect(feature?.dirtyRepos).toBe(2);
    expect(feature?.ahead).toBe(1);
    expect(feature?.behind).toBe(2);
  });

  it("omits detached/unknown-branch repos (no shared key to group on)", () => {
    const groups = groupByBranch([repo("/ws/api", undefined, [file("a")])]);
    expect(groups).toHaveLength(0);
  });

  it("attributes a run to its group when its workspace lands in a member repo", () => {
    const repos = [
      repo("/ws/api", "feat", [file("a")]),
      repo("/ws/web", "feat", [file("b")])
    ];
    const runs = [
      run("r1", "/ws/api"), // exact repo root
      run("r2", "/ws/web/packages/ui"), // nested under a member
      run("r3", "/elsewhere"), // unrelated
      run("r4", undefined) // unknown workspace — never attributed
    ];

    const [group] = groupByBranch(repos, runs);

    expect(group?.runs.map((r) => r.runId).sort()).toEqual(["r1", "r2"]);
    expect(group?.activeRuns).toBe(2);
  });

  it("counts only non-terminal runs as active", () => {
    const repos = [repo("/ws/api", "feat", [file("a")])];
    const runs = [run("r1", "/ws/api", "running"), run("r2", "/ws/api", "completed")];
    const [group] = groupByBranch(repos, runs);
    expect(group?.runs).toHaveLength(2);
    expect(group?.activeRuns).toBe(1);
  });

  it("preserves first-sighting order of branches", () => {
    const groups = groupByBranch([
      repo("/ws/z", "second", [file("a")]),
      repo("/ws/a", "first", [file("b")]),
      repo("/ws/b", "second", [file("c")])
    ]);
    expect(groups.map((g) => g.branch)).toEqual(["second", "first"]);
  });
});

describe("isInterestingGroup / isBaselineNoise", () => {
  it("treats a multi-repo branch as interesting even when clean", () => {
    const [group] = groupByBranch([repo("/a", "feat"), repo("/b", "feat")]);
    expect(isInterestingGroup(group!)).toBe(true);
    expect(isBaselineNoise(group!)).toBe(false);
  });

  it("hides a lone clean repo parked on a baseline branch", () => {
    const [group] = groupByBranch([repo("/a", "main")]);
    expect(isInterestingGroup(group!)).toBe(false);
    expect(isBaselineNoise(group!)).toBe(true);
  });

  it("keeps a lone repo with changes, unpushed commits, or a run", () => {
    const dirty = groupByBranch([repo("/a", "main", [file("x")])])[0]!;
    expect(isInterestingGroup(dirty)).toBe(true);

    const ahead = groupByBranch([repo("/a", "main", [], { ahead: 1 })])[0]!;
    expect(isInterestingGroup(ahead)).toBe(true);

    const withRun = groupByBranch([repo("/a", "main")], [run("r1", "/a")])[0]!;
    expect(isInterestingGroup(withRun)).toBe(true);
    expect(isBaselineNoise(withRun)).toBe(false);
  });

  it("does not call a non-baseline lone clean branch baseline noise", () => {
    const [group] = groupByBranch([repo("/a", "feature/solo")]);
    expect(isInterestingGroup(group!)).toBe(false);
    expect(isBaselineNoise(group!)).toBe(false);
  });
});

describe("orderGroups", () => {
  it("ranks active-run groups first, then by changed files, repos, then branch name", () => {
    const repos = [
      repo("/p/a", "alpha", [file("1")]),
      repo("/p/b", "beta", [file("1"), file("2")]),
      repo("/p/c", "gamma", [file("1"), file("2")]),
      repo("/p/d", "gamma", [file("3")]),
      repo("/p/e", "delta", [file("1")])
    ];
    const runs = [run("r1", "/p/a")]; // alpha has an active run

    const ordered = orderGroups(groupByBranch(repos, runs));

    // alpha first (active run), then gamma (3 files, 2 repos), then beta (2 files),
    // then delta (1 file). alpha has fewer files but wins on the active run.
    expect(ordered.map((g) => g.branch)).toEqual(["alpha", "gamma", "beta", "delta"]);
  });

  it("does not mutate the input array", () => {
    const groups = groupByBranch([repo("/a", "x", [file("1")]), repo("/b", "y")]);
    const snapshot = groups.map((g) => g.branch);
    orderGroups(groups);
    expect(groups.map((g) => g.branch)).toEqual(snapshot);
  });
});
