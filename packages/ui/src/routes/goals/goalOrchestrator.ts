import type {
  AgentBackend,
  BridgeEvent,
  DispatchMessage,
  DispatchRunState,
  StartRunRequest
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import {
  createGoal,
  canLaunchFirst,
  nextGoalAction,
  stopNote,
  type Goal,
  type GoalsState
} from "./goalsModel";

// Drives the bounded goal loop (control-hub roadmap #5) over the same WireClient seam the
// chat composer uses. For each goal it launches a run, accumulates its cost + transcript,
// and on completion asks the pure `goalsModel` whether to launch the next iteration (a
// follow-up carrying the transcript) or stop at a cap. Each launched run is reported via
// `onRunStarted` so it appears on the active-runs dashboard alongside chat runs.
//
// SCOPE: orchestration is client-side (it lives in the desktop app process, which also
// hosts the bridge — so it shares the app's lifetime, exactly like the client-side chat
// history). A bridge-resident, durable goal runner is the planned upgrade.

const TERMINAL_RUN: ReadonlySet<DispatchRunState> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

export interface GoalRunInit {
  runId: string;
  sessionId: string;
  backend: AgentBackend;
  task: string;
  model?: string;
  createdAt: string;
}

export interface GoalStartInput {
  objective: string;
  backend: AgentBackend;
  model?: string;
  maxIterations: number;
  spendCapUsd?: number;
}

export interface GoalOrchestratorDeps {
  /** Notified whenever the goals map changes, so the view can re-render. */
  onChange: (goals: GoalsState) => void;
  /** Notified for every launched run, so it joins the active-runs dashboard. */
  onRunStarted: (init: GoalRunInit) => void;
  /** Injectable clock + id source so the orchestrator is deterministically testable. */
  now: () => string;
  newId: () => string;
}

interface GoalRuntime {
  sessionId: string;
  currentRunId?: string | undefined;
  transcript: DispatchMessage[];
}

export class GoalOrchestrator {
  private goals: GoalsState = {};
  private readonly runtimes = new Map<string, GoalRuntime>();
  /** runId → goalId, so an incoming event is attributed to its goal. */
  private readonly runToGoal = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly client: WireClient,
    private readonly deps: GoalOrchestratorDeps
  ) {
    this.unsubscribe = client.subscribe((event) => this.onEvent(event));
  }

  /** Detach the wire subscription (call on unmount / client swap). */
  dispose(): void {
    this.unsubscribe();
  }

  list(): GoalsState {
    return this.goals;
  }

  /** Create a goal and launch its first iteration. */
  start(input: GoalStartInput): string {
    const id = this.deps.newId();
    const goal = createGoal({
      id,
      objective: input.objective,
      backend: input.backend,
      ...(input.model === undefined ? {} : { model: input.model }),
      maxIterations: input.maxIterations,
      ...(input.spendCapUsd === undefined ? {} : { spendCapUsd: input.spendCapUsd }),
      createdAt: this.deps.now()
    });
    this.goals = { ...this.goals, [id]: goal };
    this.runtimes.set(id, { sessionId: `goal-${id}`, transcript: [] });
    this.emit();
    if (canLaunchFirst(goal)) {
      void this.launch(id, goal.objective, undefined);
    }
    return id;
  }

  /** Stop a goal: cancel its in-flight run (if any) and mark it stopped. */
  stop(goalId: string): void {
    const goal = this.goals[goalId];
    if (goal === undefined) {
      return;
    }
    const runtime = this.runtimes.get(goalId);
    if (runtime?.currentRunId !== undefined) {
      void this.client.stop(runtime.currentRunId).catch(() => undefined);
    }
    this.update(goalId, { state: "stopped", note: "Stopped by you." });
  }

  /** Pause a goal: let the in-flight run finish but launch no further iterations. */
  pause(goalId: string): void {
    if (this.goals[goalId]?.state !== "running") {
      return;
    }
    this.update(goalId, { state: "paused", note: "Paused." });
  }

  /** Resume a paused goal: if no run is in flight, launch the next iteration now. */
  resume(goalId: string): void {
    if (this.goals[goalId]?.state !== "paused") {
      return;
    }
    this.update(goalId, { state: "running", note: undefined });
    const runtime = this.runtimes.get(goalId);
    const resumed = this.goals[goalId];
    if (resumed !== undefined && runtime?.currentRunId === undefined && canLaunchFirst(resumed)) {
      void this.launch(goalId, this.continuationTask(resumed.objective), undefined);
    }
  }

  private continuationTask(objective: string): string {
    return `Continue working toward this objective, then stop when it is fully met:\n\n${objective}`;
  }

  private async launch(
    goalId: string,
    taskText: string,
    followUpToRunId: string | undefined
  ): Promise<void> {
    const goal = this.goals[goalId];
    const runtime = this.runtimes.get(goalId);
    if (goal === undefined || runtime === undefined) {
      return;
    }
    const runId = this.deps.newId();
    const createdAt = this.deps.now();
    runtime.currentRunId = runId;
    this.runToGoal.set(runId, goalId);

    this.deps.onRunStarted({
      runId,
      sessionId: runtime.sessionId,
      backend: goal.backend,
      task: taskText,
      ...(goal.model === undefined ? {} : { model: goal.model }),
      createdAt
    });

    const request: StartRunRequest = {
      session: {
        id: runtime.sessionId,
        backend: goal.backend,
        title: goal.objective,
        workspaceRoot: "",
        createdAt,
        updatedAt: createdAt
      },
      workspaceRoot: "",
      task: taskText,
      requestedRunId: runId
    };
    if (goal.model !== undefined) {
      request.model = goal.model;
    }
    if (followUpToRunId !== undefined) {
      request.followUpToRunId = followUpToRunId;
      request.transcript = runtime.transcript;
    }
    try {
      await this.client.start(request);
    } catch {
      runtime.currentRunId = undefined;
      this.update(goalId, { state: "failed", note: "Could not start a run." });
    }
  }

  private onEvent(event: BridgeEvent): void {
    const goalId = this.runToGoal.get(event.runId);
    if (goalId === undefined) {
      return;
    }
    const runtime = this.runtimes.get(goalId);
    if (runtime === undefined) {
      return;
    }
    const payload = event.payload;
    switch (payload.kind) {
      case "message":
        if (payload.message.isPartial !== true) {
          runtime.transcript = [...runtime.transcript, payload.message];
        }
        break;
      case "usage":
        this.addUsd(goalId, payload.signal.totalUsd ?? 0);
        break;
      case "status":
        this.onStatus(goalId, runtime, event.runId, payload.status.state);
        break;
      default:
        break;
    }
  }

  private onStatus(
    goalId: string,
    runtime: GoalRuntime,
    runId: string,
    state: DispatchRunState
  ): void {
    if (state === "needs_input") {
      // A goal can't answer a prompt; surface it as held so the user can intervene.
      this.update(goalId, {
        state: "needs_input",
        note: "A run needs input. Open it in Runs to continue."
      });
      return;
    }
    if (!TERMINAL_RUN.has(state)) {
      return;
    }
    // The iteration finished. Detach it and decide what's next. Drop the run→goal mapping so
    // a late/duplicate event for this finished run can't re-attribute to the goal (and the map
    // doesn't grow unbounded over a long session).
    this.runToGoal.delete(runId);
    if (runtime.currentRunId === runId) {
      runtime.currentRunId = undefined;
    }
    const goal = this.goals[goalId];
    if (goal === undefined) {
      return;
    }
    if (state === "failed") {
      this.update(goalId, { state: "failed", note: "A run failed." });
      return;
    }
    if (state === "cancelled") {
      // A cancel we did not initiate still ends the goal; stop() already set the state.
      if (goal.state === "running") {
        this.update(goalId, { state: "stopped", note: "A run was cancelled." });
      }
      return;
    }
    // Completed: record the iteration, then consult the pure model.
    const recorded = this.update(goalId, { iterations: goal.iterations + 1 });
    if (recorded === undefined) {
      return;
    }
    const action = nextGoalAction(recorded);
    if (action === "continue") {
      void this.launch(goalId, this.continuationTask(recorded.objective), runId);
    } else if (action === "stop_max_iter" || action === "stop_spend_cap") {
      this.update(goalId, { state: "completed", note: stopNote(action) });
    }
    // "hold" (paused mid-flight): leave it; resume() relaunches.
  }

  private addUsd(goalId: string, usd: number): void {
    const goal = this.goals[goalId];
    if (goal === undefined) {
      return;
    }
    this.update(goalId, { totalUsd: goal.totalUsd + usd });
  }

  /** Apply a partial update to a goal, stamp `updatedAt`, emit, and return the result. */
  private update(goalId: string, patch: Partial<Goal>): Goal | undefined {
    const prev = this.goals[goalId];
    if (prev === undefined) {
      return undefined;
    }
    const next: Goal = { ...prev, ...patch, updatedAt: this.deps.now() };
    this.goals = { ...this.goals, [goalId]: next };
    this.emit();
    return next;
  }

  private emit(): void {
    this.deps.onChange(this.goals);
  }
}
