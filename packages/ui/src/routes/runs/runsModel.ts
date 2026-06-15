import type { AgentBackend, BridgeEvent, DispatchRunState } from "@honeydrunk/honeyhub-types";

// Aggregates the bridge event stream into one summary per run, so the Runs dashboard
// can show every run (across repos/sessions) at a glance — status, model, and the
// cost/tokens accumulated so far. Pure + reducer-shaped so it is trivially testable
// and the same logic backs the live view and any future persistence.

export interface RunSummary {
  runId: string;
  sessionId: string;
  backend?: AgentBackend | undefined;
  /** The task/prompt that started the run (set at launch; unknown for runs we only
      learned about from the event stream). */
  task: string;
  model?: string | undefined;
  state: DispatchRunState;
  totalUsd: number;
  totalTokens: number;
  needsInput: boolean;
  /** Count of artifacts (PRs/branches/files) the run has produced. */
  artifacts: number;
  updatedAt: string;
}

export type RunsState = Record<string, RunSummary>;

/** Register a run at launch with what the UI knows (task + chosen backend/model). */
export function registerRun(
  state: RunsState,
  init: {
    runId: string;
    sessionId: string;
    backend: AgentBackend;
    task: string;
    model?: string;
    createdAt: string;
  }
): RunsState {
  const existing = state[init.runId];
  return {
    ...state,
    [init.runId]: {
      runId: init.runId,
      sessionId: init.sessionId,
      backend: init.backend,
      task: init.task,
      model: init.model ?? existing?.model,
      state: existing?.state ?? "starting",
      totalUsd: existing?.totalUsd ?? 0,
      totalTokens: existing?.totalTokens ?? 0,
      needsInput: existing?.needsInput ?? false,
      artifacts: existing?.artifacts ?? 0,
      updatedAt: init.createdAt
    }
  };
}

/** Fold one bridge event into the runs state. Device-wide events (empty runId) and
    unrelated payloads are ignored; a run first seen here gets a minimal summary so the
    board never misses an active run. */
export function applyRunEvent(state: RunsState, event: BridgeEvent): RunsState {
  if (event.runId.length === 0) {
    return state; // device-wide (usage summary, catalogs, dir/file/search) — not a run
  }
  const payload = event.payload;
  if (
    payload.kind !== "status" &&
    payload.kind !== "usage" &&
    payload.kind !== "artifact"
  ) {
    return state;
  }

  const prev: RunSummary = state[event.runId] ?? {
    runId: event.runId,
    sessionId: event.sessionId,
    task: "(run)",
    state: "running",
    totalUsd: 0,
    totalTokens: 0,
    needsInput: false,
    artifacts: 0,
    updatedAt: event.createdAt
  };

  const next: RunSummary = { ...prev, updatedAt: event.createdAt };
  switch (payload.kind) {
    case "status":
      next.state = payload.status.state;
      next.needsInput = payload.status.state === "needs_input";
      next.backend = payload.status.backend;
      break;
    case "usage":
      next.totalUsd += payload.signal.totalUsd ?? 0;
      next.totalTokens += payload.signal.totalTokens ?? 0;
      if (payload.signal.modelLabel !== undefined) {
        next.model = payload.signal.modelLabel;
      }
      break;
    case "artifact":
      next.artifacts += 1;
      break;
  }
  return { ...state, [event.runId]: next };
}

const TERMINAL: ReadonlySet<DispatchRunState> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

export function isRunActive(summary: RunSummary): boolean {
  return !TERMINAL.has(summary.state);
}

/** Runs newest-first, active runs before terminal ones. */
export function orderRuns(state: RunsState): RunSummary[] {
  return Object.values(state).sort((a, b) => {
    const activeDelta = Number(isRunActive(b)) - Number(isRunActive(a));
    if (activeDelta !== 0) {
      return activeDelta;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}
