import type { AgentBackend } from "@honeydrunk/honeyhub-types";

// A HoneyHub-native **goal**: an objective the cockpit pursues by launching a bounded
// loop of runs toward it (packet 09 §3d / control-hub roadmap #5). Each completed run is
// one iteration; the loop continues toward the objective until a cap is hit (max
// iterations or a spend ceiling), the user stops/pauses it, or a run needs input.
//
// HONESTY: there is no automated "objective satisfied?" judge — a non-interactive CLI run
// can't be asked whether the goal is truly met. So the bound is the cap set at creation
// (default a single iteration), not a semantic stop. This module is pure + reducer-shaped
// so the orchestrator's decisions are trivially testable; the side effects (starting runs)
// live in `goalOrchestrator.ts`.

export type GoalState =
  | "running"
  | "paused"
  | "needs_input"
  | "completed"
  | "stopped"
  | "failed";

export interface Goal {
  id: string;
  objective: string;
  /** The backend the loop launches on (frozen at creation). */
  backend: AgentBackend;
  /** Optional pinned model; omitted = the adapter default. */
  model?: string;
  /** Hard ceiling on iterations (completed runs). Always ≥ 1. */
  maxIterations: number;
  /** Optional USD spend ceiling across all iterations; omitted = no cost cap. */
  spendCapUsd?: number;
  /** Completed iterations so far. */
  iterations: number;
  /** Accumulated USD across the goal's runs. */
  totalUsd: number;
  state: GoalState;
  /** Why the goal entered its current terminal/held state (user-facing). Explicitly
      nullable so a state change can clear it (exactOptionalPropertyTypes). */
  note?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type GoalsState = Record<string, Goal>;

export interface CreateGoalInput {
  id: string;
  objective: string;
  backend: AgentBackend;
  model?: string;
  maxIterations: number;
  spendCapUsd?: number;
  createdAt: string;
}

export function createGoal(input: CreateGoalInput): Goal {
  return {
    id: input.id,
    objective: input.objective.trim(),
    backend: input.backend,
    ...(input.model === undefined ? {} : { model: input.model }),
    maxIterations: Math.max(1, Math.floor(input.maxIterations)),
    ...(input.spendCapUsd === undefined ? {} : { spendCapUsd: input.spendCapUsd }),
    iterations: 0,
    totalUsd: 0,
    state: "running",
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

/** What the loop should do after recording an iteration's outcome. `continue` launches
    the next iteration; the `stop_*` verdicts end the goal; `hold` means it is paused,
    waiting on input, or already terminal — no launch. */
export type GoalAction = "continue" | "stop_max_iter" | "stop_spend_cap" | "hold";

const TERMINAL: ReadonlySet<GoalState> = new Set(["completed", "stopped", "failed"]);

export function isGoalActive(goal: Goal): boolean {
  return !TERMINAL.has(goal.state);
}

/** Decide the next loop action for a goal whose latest run just completed. A spend cap
    that is already met stops the goal even if iterations remain; otherwise the iteration
    count is the bound. Only a `running` goal continues — a paused/held/terminal one holds. */
export function nextGoalAction(goal: Goal): GoalAction {
  if (goal.state !== "running") {
    return "hold";
  }
  if (goal.spendCapUsd !== undefined && goal.totalUsd >= goal.spendCapUsd) {
    return "stop_spend_cap";
  }
  if (goal.iterations >= goal.maxIterations) {
    return "stop_max_iter";
  }
  return "continue";
}

/** Whether the goal may launch a *first* iteration (spend cap not already blown). Used
    before the loop starts, where `iterations === 0`. */
export function canLaunchFirst(goal: Goal): boolean {
  if (goal.spendCapUsd !== undefined && goal.totalUsd >= goal.spendCapUsd) {
    return false;
  }
  return goal.iterations < goal.maxIterations;
}

/** Goals newest-first, active before terminal — mirrors the runs board ordering. */
export function orderGoals(state: GoalsState): Goal[] {
  return Object.values(state).sort((a, b) => {
    const activeDelta = Number(isGoalActive(b)) - Number(isGoalActive(a));
    if (activeDelta !== 0) {
      return activeDelta;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

/** Human-readable reason for a stop verdict, for the goal's `note`. */
export function stopNote(action: Extract<GoalAction, "stop_max_iter" | "stop_spend_cap">): string {
  return action === "stop_max_iter"
    ? "Reached the iteration limit."
    : "Reached the spend limit.";
}
