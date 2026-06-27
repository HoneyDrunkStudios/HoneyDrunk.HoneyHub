import { describe, expect, it } from "vitest";
import type {
  BridgeEvent,
  BridgeEventPayload,
  DispatchRunState,
  StartRunRequest
} from "@honeydrunk/honeyhub-types";
import type { StartedRun, WireClient, WireEventHandler } from "../../wire/client";
import { GoalOrchestrator, type GoalRunInit } from "./goalOrchestrator";
import type { GoalsState } from "./goalsModel";

/** A controllable WireClient: records starts/stops and lets the test drive events. */
class FakeClient implements WireClient {
  readonly handlers = new Set<WireEventHandler>();
  readonly starts: StartRunRequest[] = [];
  readonly stops: string[] = [];
  private seq = 0;

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async start(request: StartRunRequest): Promise<StartedRun> {
    this.starts.push(request);
    return { runId: request.requestedRunId ?? "run" };
  }
  async reply(): Promise<void> {}
  async stop(runId: string): Promise<void> {
    this.stops.push(runId);
  }
  async requestUsageSummary(): Promise<void> {}
  async requestCoachingHints(): Promise<void> {}
  async discoverAgents(): Promise<void> {}
  async discoverBackends(): Promise<void> {}
  async setWorkspaceRoots(): Promise<void> {}
  async browseDir(): Promise<void> {}
  async readFile(): Promise<void> {}
  async searchFiles(): Promise<void> {}
  async resolveWorkspaceFile(): Promise<void> {}
  async writeAgent(): Promise<void> {}
  async listJobs(): Promise<void> {}
  async detectEnvironment(): Promise<void> {}
  async listNetwork(): Promise<void> {}
  async listWork(): Promise<void> {}
  async listServiceBus(): Promise<void> {}
  async listAzureSubscriptions(): Promise<void> {}
  async listKeyVaults(): Promise<void> {}
  async listVaultObjects(): Promise<void> {}
  async revealSecret(): Promise<void> {}
  async scanKeyVaultExpiry(): Promise<void> {}
  async peekServiceBus(): Promise<void> {}
  async resubmitDeadLetter(): Promise<void> {}
  async purgeServiceBus(): Promise<void> {}
  async sendServiceBus(): Promise<void> {}
  async receiveServiceBus(): Promise<void> {}
  async listServiceBusEntities(): Promise<void> {}
  async manageServiceBus(): Promise<void> {}
  async grafanaSummary(): Promise<void> {}
  async sentrySummary(): Promise<void> {}
  async gitStatus(): Promise<void> {}
  async gitDiff(): Promise<void> {}
  async gitOverview(): Promise<void> {}
  async gitBranches(): Promise<void> {}
  async gitStage(): Promise<void> {}
  async gitUnstage(): Promise<void> {}
  async gitCommit(): Promise<void> {}
  async gitPush(): Promise<void> {}
  async gitPull(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
  async gitDiscard(): Promise<void> {}
  async gitDiscardAll(): Promise<void> {}
  async gitDeleteBranch(): Promise<void> {}
  async listSessions(): Promise<void> {}
  async sessionDetail(): Promise<void> {}
  async roadmap(): Promise<void> {}
  async scaffoldArchitecture(): Promise<void> {}
  async pullArchitecture(): Promise<void> {}
  async runCheck(): Promise<void> {}

  private emit(runId: string, payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: `e-${this.seq}`,
      sessionId: "s",
      runId,
      sequence: this.seq,
      createdAt: "t",
      payload
    };
    this.seq += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }
  status(runId: string, state: DispatchRunState): void {
    this.emit(runId, { kind: "status", status: { state, backend: "claude.local" } });
  }
  usage(runId: string, totalUsd: number): void {
    this.emit(runId, {
      kind: "usage",
      signal: {
        id: `u-${runId}`,
        sessionId: "s",
        runId,
        backend: "claude.local",
        fidelity: "exact",
        totalUsd,
        recordedAt: "t"
      }
    });
  }
}

interface Harness {
  client: FakeClient;
  orchestrator: GoalOrchestrator;
  runs: GoalRunInit[];
  goals: () => GoalsState;
  lastRunId: () => string;
}

function harness(): Harness {
  const client = new FakeClient();
  const runs: GoalRunInit[] = [];
  let goalsState: GoalsState = {};
  let n = 0;
  const orchestrator = new GoalOrchestrator(client, {
    onChange: (next) => {
      goalsState = next;
    },
    onRunStarted: (init) => runs.push(init),
    now: () => "t",
    newId: () => `id-${n++}`
  });
  return {
    client,
    orchestrator,
    runs,
    goals: () => goalsState,
    lastRunId: () => client.starts.at(-1)?.requestedRunId ?? ""
  };
}

describe("GoalOrchestrator", () => {
  it("launches the first iteration and registers it on the runs board", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 2
    });
    expect(h.client.starts).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.task).toBe("ship it");
    expect(h.goals()[id]!.state).toBe("running");
  });

  it("re-runs as a follow-up until the iteration cap, then completes", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 2
    });
    // First iteration completes -> a second is launched as a follow-up carrying transcript.
    h.client.status(h.lastRunId(), "completed");
    expect(h.client.starts).toHaveLength(2);
    expect(h.client.starts[1]!.followUpToRunId).toBe(h.client.starts[0]!.requestedRunId);
    expect(h.goals()[id]!.iterations).toBe(1);
    // Second iteration completes -> cap reached -> goal done.
    h.client.status(h.lastRunId(), "completed");
    expect(h.client.starts).toHaveLength(2);
    expect(h.goals()[id]!.state).toBe("completed");
    expect(h.goals()[id]!.iterations).toBe(2);
  });

  it("stops at a spend cap before exhausting iterations", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 5,
      spendCapUsd: 0.1
    });
    h.client.usage(h.lastRunId(), 0.15);
    h.client.status(h.lastRunId(), "completed");
    expect(h.goals()[id]!.state).toBe("completed");
    expect(h.goals()[id]!.note).toMatch(/spend/i);
    expect(h.client.starts).toHaveLength(1);
  });

  it("holds on needs_input", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 3
    });
    h.client.status(h.lastRunId(), "needs_input");
    expect(h.goals()[id]!.state).toBe("needs_input");
    expect(h.client.starts).toHaveLength(1);
  });

  it("stops a goal and cancels its in-flight run", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 3
    });
    const runId = h.lastRunId();
    h.orchestrator.stop(id);
    expect(h.goals()[id]!.state).toBe("stopped");
    expect(h.client.stops).toContain(runId);
  });

  it("pauses, then resumes by launching another iteration", () => {
    const h = harness();
    const id = h.orchestrator.start({
      objective: "ship it",
      backend: "claude.local",
      maxIterations: 3
    });
    // Finish the first run while paused so no follow-up auto-launches.
    h.orchestrator.pause(id);
    h.client.status(h.lastRunId(), "completed");
    expect(h.client.starts).toHaveLength(1);
    expect(h.goals()[id]!.state).toBe("paused");
    // Resume -> a fresh iteration launches.
    h.orchestrator.resume(id);
    expect(h.client.starts).toHaveLength(2);
    expect(h.goals()[id]!.state).toBe("running");
  });
});
