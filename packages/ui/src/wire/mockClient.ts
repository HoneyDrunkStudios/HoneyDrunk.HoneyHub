import type {
  AgentBackend,
  AgentDefinition,
  BridgeEvent,
  BridgeEventPayload,
  DispatchRunState,
  PolicyHint,
  StartRunRequest,
  UsageSignal
} from "@honeydrunk/honeyhub-types";
import { summarizeUsage } from "../routes/spend/spendModel";
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
  // Accumulate the usage the demo emits so `requestUsageSummary` can roll it up the
  // same way the real host does (mirroring `UsageSummary::from_signals`).
  private usageSignals: UsageSignal[] = [];
  private sessionIds = new Set<string>();

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(sessionId: string, runId: string, payload: BridgeEventPayload): void {
    if (payload.kind === "usage") {
      this.usageSignals.push(payload.signal);
    }
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
    this.sessionIds.add(sessionId);

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

  async requestUsageSummary(): Promise<void> {
    // The host answers a usage-summary query with a device-wide event; the mock
    // rolls up the usage it has emitted so far through the same aggregator the UI
    // ships, and surfaces it as a `usage_summary` event (session/run ids empty,
    // matching the bridge's device-scoped event).
    const summary = summarizeUsage(this.usageSignals, this.sessionIds.size);
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      // Device-scoped event: sequence is 0 to match the bridge's
      // `BridgeEvent::usage_summary` contract (it is not part of any run's ordered
      // stream). The id still uses the counter so it stays unique.
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "usage_summary", summary }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async requestCoachingHints(): Promise<void> {
    // The real host runs the Rust coaching engine over EVERY session; the offline
    // mock can't, so it surfaces a small set of *scripted demo* advisories for each
    // session it has seen — enough to exercise the cross-session surface (ordering,
    // multiple sessions) without re-implementing the engine. With no session yet, it
    // returns none (honest empty state).
    const hints: PolicyHint[] = [...this.sessionIds].flatMap((sessionId) => [
      {
        id: `coach:${sessionId}:stale_session`,
        sessionId,
        code: "stale_session",
        severity: "warning" as const,
        message:
          "This session has grown large. Starting a fresh session keeps the agent focused and can respond faster and cost less.",
        createdAt: this.createdAt
      },
      {
        id: `coach:${sessionId}:estimate_only_spend`,
        sessionId,
        code: "estimate_only_spend",
        severity: "info" as const,
        message:
          "Some usage for this session is estimated, so the spend figures shown are approximate rather than exact.",
        createdAt: this.createdAt
      }
    ]);
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "coaching_hints", hints }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async discoverAgents(_workspaceRoot?: string): Promise<void> {
    // The real host scans the filesystem; the mock returns a small *scripted demo*
    // catalog so the Agents surface is exercised offline: one Claude subagent runnable
    // on both Claude and Copilot (the multi-backend, one-entry-per-name shape), and one
    // global Copilot agent.
    // A fixed scripted-demo label (the host derives one from the root's basename or a
    // hash; the mock keeps it constant so it never diverges for a rootless root).
    const label = "demo";
    // Mirror the host id shape: an opaque hash of the name (the real ids are FNV-hashed),
    // so demos/tests don't depend on a format the host never produces.
    const agents: AgentDefinition[] = [
      {
        id: "00000000000000a1",
        name: "Code Reviewer",
        backends: [
          {
            backend: "claude.local",
            description: "Reviews a diff against the Grid invariants before a PR.",
            model: "claude-opus",
            sourcePath: ".claude/agents/code-reviewer.md",
            scope: "project",
            workspaceLabel: label
          },
          {
            backend: "copilot.local",
            description: "Reviews a diff before a PR.",
            sourcePath: ".copilot/agents/code-reviewer.md",
            scope: "project",
            workspaceLabel: label
          }
        ]
      },
      {
        id: "00000000000000b2",
        name: "release agent",
        backends: [
          {
            backend: "copilot.local",
            description: "Drafts release notes from merged PRs.",
            sourcePath: ".copilot/agents/release-agent.md",
            scope: "global",
            workspaceLabel: "global"
          }
        ]
      }
    ];
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "agent_catalog", agents }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
