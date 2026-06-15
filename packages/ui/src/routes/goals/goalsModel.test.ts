import { describe, expect, it } from "vitest";
import {
  canLaunchFirst,
  createGoal,
  isGoalActive,
  nextGoalAction,
  orderGoals,
  stopNote,
  type Goal
} from "./goalsModel";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    ...createGoal({
      id: "g1",
      objective: "  ship it  ",
      backend: "claude.local",
      maxIterations: 3,
      createdAt: "2026-06-14T00:00:00.000Z"
    }),
    ...overrides
  };
}

describe("goalsModel", () => {
  it("creates a goal with trimmed objective and floor-clamped iterations", () => {
    const g = createGoal({
      id: "g1",
      objective: "  do the thing  ",
      backend: "claude.local",
      maxIterations: 0,
      createdAt: "t0"
    });
    expect(g.objective).toBe("do the thing");
    expect(g.maxIterations).toBe(1);
    expect(g.state).toBe("running");
    expect(g.iterations).toBe(0);
  });

  it("continues while under the iteration cap and stops at it", () => {
    expect(nextGoalAction(goal({ iterations: 1 }))).toBe("continue");
    expect(nextGoalAction(goal({ iterations: 3 }))).toBe("stop_max_iter");
  });

  it("stops on a met spend cap even with iterations remaining", () => {
    expect(
      nextGoalAction(goal({ iterations: 1, totalUsd: 0.5, spendCapUsd: 0.5 }))
    ).toBe("stop_spend_cap");
  });

  it("holds when not running", () => {
    expect(nextGoalAction(goal({ state: "paused", iterations: 0 }))).toBe("hold");
  });

  it("gates the first launch on the spend cap", () => {
    expect(canLaunchFirst(goal())).toBe(true);
    expect(canLaunchFirst(goal({ totalUsd: 1, spendCapUsd: 1 }))).toBe(false);
  });

  it("orders active goals before terminal ones, newest first", () => {
    const a = goal({ id: "a", state: "running", updatedAt: "2026-06-14T01:00:00Z" });
    const b = goal({ id: "b", state: "completed", updatedAt: "2026-06-14T03:00:00Z" });
    const c = goal({ id: "c", state: "running", updatedAt: "2026-06-14T02:00:00Z" });
    const ordered = orderGoals({ a, b, c }).map((g) => g.id);
    expect(ordered).toEqual(["c", "a", "b"]);
  });

  it("reports active state and stop notes", () => {
    expect(isGoalActive(goal({ state: "running" }))).toBe(true);
    expect(isGoalActive(goal({ state: "completed" }))).toBe(false);
    expect(stopNote("stop_max_iter")).toMatch(/iteration/i);
    expect(stopNote("stop_spend_cap")).toMatch(/spend/i);
  });
});
