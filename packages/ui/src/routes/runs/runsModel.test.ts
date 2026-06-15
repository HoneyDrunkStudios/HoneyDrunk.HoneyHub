import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "@honeydrunk/honeyhub-types";
import { applyRunEvent, orderRuns, registerRun, type RunsState } from "./runsModel";

function status(runId: string, state: string, createdAt: string): BridgeEvent {
  return {
    id: `e-${createdAt}`,
    sessionId: "s1",
    runId,
    sequence: 0,
    createdAt,
    payload: { kind: "status", status: { state: state as never, backend: "claude.local" } }
  };
}

describe("runsModel", () => {
  it("registers a run with task + backend, then tracks status/usage", () => {
    let state: RunsState = registerRun(
      {},
      {
        runId: "r1",
        sessionId: "s1",
        backend: "claude.local",
        task: "Fix the bug",
        model: "opus",
        createdAt: "2026-06-14T00:00:00Z"
      }
    );
    expect(state.r1!.task).toBe("Fix the bug");
    expect(state.r1!.state).toBe("starting");

    state = applyRunEvent(state, status("r1", "needs_input", "2026-06-14T00:01:00Z"));
    expect(state.r1!.state).toBe("needs_input");
    expect(state.r1!.needsInput).toBe(true);

    state = applyRunEvent(state, {
      id: "u1",
      sessionId: "s1",
      runId: "r1",
      sequence: 0,
      createdAt: "2026-06-14T00:02:00Z",
      payload: {
        kind: "usage",
        signal: {
          id: "sig1",
          sessionId: "s1",
          runId: "r1",
          backend: "claude.local",
          fidelity: "exact",
          modelLabel: "claude-opus",
          totalTokens: 1540,
          totalUsd: 0.0182,
          recordedAt: "2026-06-14T00:02:00Z"
        }
      }
    });
    expect(state.r1!.totalUsd).toBeCloseTo(0.0182);
    expect(state.r1!.totalTokens).toBe(1540);
    expect(state.r1!.model).toBe("claude-opus");
  });

  it("ignores device-wide events (empty runId)", () => {
    const before: RunsState = {};
    const after = applyRunEvent(before, {
      id: "x",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-14T00:00:00Z",
      payload: { kind: "agent_catalog", agents: [] }
    });
    expect(after).toEqual({});
  });

  it("creates a minimal summary for a run first seen via the stream", () => {
    const state = applyRunEvent({}, status("r9", "running", "2026-06-14T00:00:00Z"));
    expect(state.r9!.task).toBe("(run)");
    expect(state.r9!.state).toBe("running");
    expect(state.r9!.backend).toBe("claude.local");
  });

  it("orders active runs before terminal, newest first", () => {
    let state: RunsState = {};
    state = applyRunEvent(state, status("done", "completed", "2026-06-14T00:05:00Z"));
    state = applyRunEvent(state, status("active", "running", "2026-06-14T00:01:00Z"));
    const order = orderRuns(state).map((r) => r.runId);
    expect(order[0]).toBe("active"); // active beats a newer terminal run
  });
});
