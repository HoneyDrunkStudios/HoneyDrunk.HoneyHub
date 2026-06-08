import type {
  AgentBackend,
  BridgeEvent,
  BridgeEventPayload,
  DispatchRunState,
  StartRunRequest
} from "@honeydrunk/honeyhub-types";
import type { StartedRun, WireClient, WireEventHandler } from "./client";

// An in-memory wire client that scripts a realistic Claude Code exchange:
// start -> stream -> needs_input -> (reply) -> usage + PR artifact -> completed,
// and stop -> stopping -> cancelled. It backs the offline demo and the RTL test;
// the real WebSocket client implements the same `WireClient` seam later.

interface MockState {
  sessionId: string;
  backend: AgentBackend;
}

export class MockWireClient implements WireClient {
  private handlers = new Set<WireEventHandler>();
  private sequence = 0;
  private runs = new Map<string, MockState>();
  private createdAt = "2026-06-07T12:00:00.000Z";

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(sessionId: string, runId: string, payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId,
      runId,
      sequence: this.sequence,
      createdAt: this.createdAt,
      payload
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private status(sessionId: string, runId: string, backend: AgentBackend, state: DispatchRunState) {
    this.emit(sessionId, runId, { kind: "status", status: { state, backend } });
  }

  private message(
    sessionId: string,
    runId: string,
    body: string,
    isPartial: boolean
  ): void {
    this.emit(sessionId, runId, {
      kind: "message",
      message: {
        id: `message-${this.sequence}`,
        sessionId,
        runId,
        role: "agent",
        body,
        createdAt: this.createdAt,
        isPartial
      }
    });
  }

  async start(request: StartRunRequest): Promise<StartedRun> {
    const runId = request.requestedRunId ?? `run-${this.runs.size + 1}`;
    const sessionId = request.session.id;
    const backend = request.session.backend;
    this.runs.set(runId, { sessionId, backend });

    this.status(sessionId, runId, backend, "running");
    this.message(sessionId, runId, "Reading the workspace", true);
    this.message(sessionId, runId, "I can take that on. Which file should I change?", false);
    this.status(sessionId, runId, backend, "needs_input");

    return { runId };
  }

  async reply(runId: string, _text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`unknown run ${runId}`);
    }
    const { sessionId, backend } = run;

    this.status(sessionId, runId, backend, "running");
    this.message(sessionId, runId, "Applying the change", true);
    this.message(sessionId, runId, "Done — opened a pull request.", false);
    this.emit(sessionId, runId, {
      kind: "usage",
      signal: {
        id: `usage-${this.sequence}`,
        sessionId,
        runId,
        backend,
        fidelity: "exact",
        modelLabel: "claude",
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        totalUsd: 0.0182,
        recordedAt: this.createdAt
      }
    });
    this.emit(sessionId, runId, {
      kind: "artifact",
      artifact: {
        id: `artifact-${this.sequence}`,
        sessionId,
        runId,
        kind: "pull_request",
        label: "Open PR",
        href: "https://example.test/pr/1",
        createdAt: this.createdAt
      }
    });
    this.status(sessionId, runId, backend, "finalizing");
    this.status(sessionId, runId, backend, "completed");
  }

  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`unknown run ${runId}`);
    }
    const { sessionId, backend } = run;
    this.status(sessionId, runId, backend, "stopping");
    this.status(sessionId, runId, backend, "cancelled");
  }
}
