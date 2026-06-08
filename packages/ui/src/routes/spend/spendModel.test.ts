import { describe, expect, it } from "vitest";
import type { AgentBackend, UsageFidelity, UsageSignal } from "@honeydrunk/honeyhub-types";
import {
  backendLabel,
  fidelityNote,
  groundedHeadline,
  hasSpend,
  rollupCost,
  summarizeUsage
} from "./spendModel";

function usage(
  backend: AgentBackend,
  fidelity: UsageFidelity,
  tokens: number,
  totalUsd?: number,
  premiumRequests?: number,
  durationMs = 0
): UsageSignal {
  return {
    id: "u",
    sessionId: "s",
    runId: "r",
    backend,
    fidelity,
    inputTokens: Math.floor(tokens / 2),
    outputTokens: Math.floor(tokens / 2),
    totalTokens: tokens,
    durationMs,
    recordedAt: "2026-06-07T12:00:00Z",
    ...(totalUsd !== undefined ? { totalUsd } : {}),
    ...(premiumRequests !== undefined ? { premiumRequests } : {})
  };
}

describe("summarizeUsage", () => {
  it("keeps fidelities separate and grounds only measured USD", () => {
    const summary = summarizeUsage(
      [
        usage("claude.local", "exact", 100, 0.1, undefined, 1000),
        usage("claude.local", "exact", 60, 0.05, undefined, 500),
        usage("codex.local", "derived", 40, 0.02, undefined, 300),
        usage("copilot.local", "estimated", 20, undefined, 1, 1800)
      ],
      3
    );

    expect(summary.sessionCount).toBe(3);
    expect(summary.totalTurns).toBe(4);
    // Grounded = exact (0.10 + 0.05) + derived (0.02); estimated excluded.
    expect(summary.groundedTotalUsd).toBeCloseTo(0.17, 10);
    expect(summary.totalPremiumRequests).toBe(1);

    // Deterministic (backend, fidelity) order.
    expect(summary.rollups.map((r) => r.backend)).toEqual([
      "claude.local",
      "codex.local",
      "copilot.local"
    ]);
    const claude = summary.rollups[0];
    expect(claude?.turnCount).toBe(2);
    expect(claude?.totalTokens).toBe(160);
    expect(claude?.totalUsd).toBeCloseTo(0.15, 10);
    const copilot = summary.rollups[2];
    expect(copilot?.totalUsd).toBeUndefined();
    expect(copilot?.premiumRequests).toBe(1);
  });

  it("orders same-backend rollups by Rust enum order, not lexicographically", () => {
    // exact < derived < estimated is the Rust enum order — and is NOT alphabetical
    // ("derived" < "estimated" < "exact"), so a string sort would diverge from the
    // host. Feed them out of order and assert the contract order.
    const summary = summarizeUsage(
      [
        usage("claude.local", "estimated", 10, undefined, 1),
        usage("claude.local", "exact", 10, 0.01),
        usage("claude.local", "derived", 10, 0.01)
      ],
      1
    );
    expect(summary.rollups.map((r) => r.fidelity)).toEqual(["exact", "derived", "estimated"]);
  });

  it("counts premium requests only from estimated rollups", () => {
    // A stray premium-request count on a non-estimated signal must not inflate the
    // total (mirrors the Rust aggregator).
    const summary = summarizeUsage(
      [
        usage("claude.local", "exact", 10, 0.01, 5),
        usage("copilot.local", "estimated", 10, undefined, 2)
      ],
      1
    );
    expect(summary.totalPremiumRequests).toBe(2);
    // And the exact rollup's per-backend field stays absent (no leak into the row).
    expect(
      summary.rollups.find((r) => r.backend === "claude.local")?.premiumRequests
    ).toBeUndefined();
  });

  it("reports no grounded total when only estimated activity exists", () => {
    const summary = summarizeUsage([usage("copilot.local", "estimated", 20, undefined, 2)], 1);
    expect(summary.groundedTotalUsd).toBeUndefined();
    expect(summary.totalPremiumRequests).toBe(2);
  });

  it("is empty for no signals", () => {
    const summary = summarizeUsage([], 0);
    expect(summary.rollups).toHaveLength(0);
    expect(hasSpend(summary)).toBe(false);
    expect(groundedHeadline(summary)).toBeUndefined();
  });
});

describe("display helpers", () => {
  it("labels backends and fidelities for humans", () => {
    expect(backendLabel("claude.local")).toBe("Claude Code");
    expect(backendLabel("copilot.local")).toBe("Copilot");
    expect(fidelityNote("exact")).toBe("measured");
    expect(fidelityNote("derived")).toBe("rate-derived");
    expect(fidelityNote("estimated")).toBe("estimated");
  });

  it("formats the grounded headline to cents", () => {
    const summary = summarizeUsage([usage("claude.local", "exact", 100, 1.2345)], 1);
    expect(groundedHeadline(summary)).toBe("$1.23");
  });

  it("shows a fidelity-prefixed cost for dollar rollups and a count for premium ones", () => {
    const exact = summarizeUsage([usage("claude.local", "exact", 100, 0.5)], 1).rollups[0];
    expect(exact && rollupCost(exact)).toBe("$0.5000");
    const derived = summarizeUsage([usage("codex.local", "derived", 100, 0.5)], 1).rollups[0];
    expect(derived && rollupCost(derived)).toBe("≈$0.5000");
    const estimated = summarizeUsage(
      [usage("copilot.local", "estimated", 100, undefined, 3)],
      1
    ).rollups[0];
    expect(estimated && rollupCost(estimated)).toBe("3 premium requests");
    const singlePremium = summarizeUsage(
      [usage("copilot.local", "estimated", 100, undefined, 1)],
      1
    ).rollups[0];
    expect(singlePremium && rollupCost(singlePremium)).toBe("1 premium request");
  });
});
