import { describe, expect, it } from "vitest";
import type { DispatchMessage, UsageSignal } from "@honeydrunk/honeyhub-types";
import {
  computeSessionDiagnostics,
  LONG_SESSION_TOKENS
} from "./diagnosticsModel";

function message(id: string, body: string, createdAt: string): DispatchMessage {
  return {
    id,
    sessionId: "s1",
    runId: "r1",
    role: "agent",
    body,
    createdAt,
    isPartial: false
  };
}

function usage(totalTokens: number, totalUsd: number, model = "claude"): UsageSignal {
  return {
    id: `u-${totalTokens}`,
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    fidelity: "exact",
    modelLabel: model,
    inputTokens: totalTokens - 40,
    outputTokens: 40,
    totalTokens,
    totalUsd,
    recordedAt: "2026-06-08T12:00:00Z"
  };
}

describe("computeSessionDiagnostics", () => {
  it("reports a pending model and zero usage before any usage signal", () => {
    const diagnostics = computeSessionDiagnostics({
      backend: "claude.local",
      messages: [message("m1", "hi", "2026-06-08T12:00:00Z")],
      usage: []
    });
    expect(diagnostics.provider).toBe("claude.local");
    expect(diagnostics.model).toBe("pending");
    expect(diagnostics.sessionTokens).toBe(0);
    expect(diagnostics.sessionUsd).toBeUndefined();
    expect(diagnostics.messageCount).toBe(1);
    expect(diagnostics.health.level).toBe("good");
  });

  it("sums session usage and reports the last turn + model + fidelity", () => {
    const diagnostics = computeSessionDiagnostics({
      backend: "claude.local",
      messages: [
        message("m1", "a", "2026-06-08T12:00:00.000Z"),
        message("m2", "b", "2026-06-08T12:02:00.000Z")
      ],
      usage: [usage(100, 0.01), usage(150, 0.02, "claude-sonnet")]
    });
    expect(diagnostics.sessionTokens).toBe(250);
    expect(diagnostics.sessionUsd).toBeCloseTo(0.03);
    expect(diagnostics.lastTurnTokens).toBe(150);
    expect(diagnostics.lastTurnUsd).toBeCloseTo(0.02);
    expect(diagnostics.model).toBe("claude-sonnet");
    expect(diagnostics.fidelity).toBe("exact");
    expect(diagnostics.elapsedMs).toBe(120_000);
  });

  it("rolls aggregate fidelity up conservatively across mixed signals", () => {
    const estimated: UsageSignal = { ...usage(50, 0.5), fidelity: "estimated" };
    const exact: UsageSignal = { ...usage(60, 0.6), fidelity: "exact" };
    const diagnostics = computeSessionDiagnostics({
      backend: "claude.local",
      messages: [message("m1", "x", "2026-06-08T12:00:00Z")],
      usage: [estimated, exact]
    });
    // The aggregate is only as precise as its least-precise part...
    expect(diagnostics.sessionFidelity).toBe("estimated");
    // ...while the last turn reflects the latest signal's fidelity.
    expect(diagnostics.fidelity).toBe("exact");
  });

  it("flags a long session with a switch recommendation", () => {
    const diagnostics = computeSessionDiagnostics({
      backend: "claude.local",
      messages: [message("m1", "x", "2026-06-08T12:00:00Z")],
      usage: [usage(LONG_SESSION_TOKENS + 10_000, 1.5)]
    });
    expect(diagnostics.health.level).toBe("watch");
    expect(diagnostics.health.recommendations.length).toBeGreaterThan(0);
    expect(diagnostics.health.recommendations[0]).toMatch(/fresh session/i);
  });
});
