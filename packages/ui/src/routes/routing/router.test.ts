import { describe, expect, it } from "vitest";
import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { estimateComplexity, recommendBackend } from "./router";
import { loadRoutingSnapshot } from "./routingSnapshot";

const ALL: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];
// The loaded snapshot (v1: the bundled JSON projection) under test.
const BUNDLED_SNAPSHOT = loadRoutingSnapshot();

describe("estimateComplexity", () => {
  it("scores keyword-heavy refactors high and light edits low", () => {
    const complex = estimateComplexity(
      "Refactor the auth module and investigate the race condition in the token cache"
    );
    const light = estimateComplexity("Fix a typo in the README");
    expect(complex).toBeGreaterThan(0.5);
    expect(light).toBeLessThan(0.5);
    expect(complex).toBeGreaterThan(light);
  });

  it("stays within 0..1", () => {
    expect(estimateComplexity("")).toBeGreaterThanOrEqual(0);
    expect(estimateComplexity("refactor ".repeat(50))).toBeLessThanOrEqual(1);
  });
});

describe("recommendBackend", () => {
  it("routes a complex task to the most capable backend", () => {
    const rec = recommendBackend(
      { task: "Redesign and refactor the concurrency model; debug the race condition", availableBackends: ALL },
      BUNDLED_SNAPSHOT
    );
    // Claude has the highest capability tier in the bundled snapshot.
    expect(rec.backend).toBe("claude.local");
    expect(rec.rationale).toMatch(/Complex/);
    expect(rec.ranked[0]?.backend).toBe("claude.local");
  });

  it("routes a light task to the lowest-cost backend", () => {
    const rec = recommendBackend(
      { task: "Fix a typo and reformat a comment", availableBackends: ALL },
      BUNDLED_SNAPSHOT
    );
    // Codex is the lowest cost tier in the bundled snapshot (Copilot is not offered).
    expect(rec.backend).toBe("codex.local");
    expect(rec.rationale).toMatch(/Light/);
  });

  it("only considers available backends", () => {
    const rec = recommendBackend(
      { task: "Redesign the architecture", availableBackends: ["codex.local"] },
      BUNDLED_SNAPSHOT
    );
    // The most capable (claude) is unavailable here, so it is never chosen.
    expect(rec.backend).not.toBe("claude.local");
    expect(rec.ranked.map((r) => r.backend).sort()).toEqual(["codex.local"]);
  });

  it("applies recent usage only as a soft tiebreak, never overriding a clear winner", () => {
    // Light task → cost wins; Codex (cheapest) stays the pick even though it has some
    // recent usage, because the cost gap dominates the small usage penalty.
    const rec = recommendBackend(
      {
        task: "rename a variable",
        availableBackends: ALL,
        recentTurnsByBackend: { "codex.local": 3 }
      },
      BUNDLED_SNAPSHOT
    );
    expect(rec.backend).toBe("codex.local");

    // But between two equal-tier backends, heavy usage tips the balance.
    const tieSnapshot = {
      ...BUNDLED_SNAPSHOT,
      rates: [
        { backend: "codex.local" as AgentBackend, modelLabel: "a", costTier: 1, capabilityTier: 2 },
        { backend: "copilot.local" as AgentBackend, modelLabel: "b", costTier: 1, capabilityTier: 2 }
      ]
    };
    const tie = recommendBackend(
      {
        task: "rename a variable",
        availableBackends: ["codex.local", "copilot.local"],
        recentTurnsByBackend: { "codex.local": 10 }
      },
      tieSnapshot
    );
    expect(tie.backend).toBe("copilot.local");
    expect(tie.rationale).toMatch(/less-used subscription/);
  });

  it("never lets a negative recent-usage count become a scoring advantage", () => {
    // Two equal-tier backends; a NEGATIVE count for codex must not boost it past
    // copilot (which would happen if the penalty weren't clamped at 0). With both
    // clamped to 0 the tiebreak is the stable backend-id order (codex < copilot).
    const tieSnapshot = {
      ...BUNDLED_SNAPSHOT,
      rates: [
        { backend: "codex.local" as AgentBackend, modelLabel: "a", costTier: 1, capabilityTier: 2 },
        { backend: "copilot.local" as AgentBackend, modelLabel: "b", costTier: 1, capabilityTier: 2 }
      ]
    };
    const rec = recommendBackend(
      {
        task: "rename a variable",
        availableBackends: ["codex.local", "copilot.local"],
        recentTurnsByBackend: { "codex.local": -100 }
      },
      tieSnapshot
    );
    expect(rec.backend).toBe("codex.local");
    // No usage actually influenced the order, so no nudge note.
    expect(rec.rationale).not.toMatch(/less-used subscription/);
  });

  it("ignores plans when none are set (behavior unchanged)", () => {
    const withEmptyPlans = recommendBackend(
      { task: "Fix a typo and reformat a comment", availableBackends: ALL, plans: {} },
      BUNDLED_SNAPSHOT
    );
    const without = recommendBackend(
      { task: "Fix a typo and reformat a comment", availableBackends: ALL },
      BUNDLED_SNAPSHOT
    );
    expect(withEmptyPlans.backend).toBe("codex.local");
    expect(withEmptyPlans).toEqual(without);
  });

  it("lets a flat plan on the pricier backend win a light task over a cheaper metered one", () => {
    // Codex is cheaper per token (costTier 1) and would normally win a light task;
    // Claude is pricier (costTier 3). A flat-rate Claude sub makes its requests
    // effectively free, so it should win — and Codex being explicitly metered does not
    // help it.
    const rec = recommendBackend(
      {
        task: "Fix a typo and reformat a comment",
        availableBackends: ALL,
        plans: { "claude.local": { type: "flat", monthlyUsd: 20 }, "codex.local": { type: "metered" } }
      },
      BUNDLED_SNAPSHOT
    );
    expect(rec.backend).toBe("claude.local");
    expect(rec.rationale).toMatch(/favoring your flat-rate Claude Code plan/);
  });

  it("mentions the flat plan only when it actually flipped the choice", () => {
    // A flat plan on the backend that would ALREADY win (Codex, the cheapest) changes
    // nothing, so the rationale must not claim the plan favored it.
    const noFlip = recommendBackend(
      {
        task: "Fix a typo and reformat a comment",
        availableBackends: ALL,
        plans: { "codex.local": { type: "flat", monthlyUsd: 10 } }
      },
      BUNDLED_SNAPSHOT
    );
    expect(noFlip.backend).toBe("codex.local");
    expect(noFlip.rationale).not.toMatch(/flat-rate/);

    // A flat plan only affects COST mode: on a complex task (capability mode) it must
    // not flip the winner nor be credited.
    const complex = recommendBackend(
      {
        task: "Redesign and refactor the concurrency model; debug the race condition",
        availableBackends: ALL,
        plans: { "codex.local": { type: "flat", monthlyUsd: 10 } }
      },
      BUNDLED_SNAPSHOT
    );
    expect(complex.backend).toBe("claude.local");
    expect(complex.rationale).not.toMatch(/flat-rate/);
  });

  it("falls back to the default when no snapshot rate matches", () => {
    const emptyRates = { ...BUNDLED_SNAPSHOT, rates: [] };
    const rec = recommendBackend({ task: "anything", availableBackends: ALL }, emptyRates);
    expect(rec.backend).toBe(BUNDLED_SNAPSHOT.policy.defaultBackend);
    expect(rec.rationale).toMatch(/default/i);
  });

  it("names the first available backend when the default itself is unavailable", () => {
    const emptyRates = { ...BUNDLED_SNAPSHOT, rates: [] };
    // The policy default (claude.local) is not among the available backends here.
    const rec = recommendBackend(
      { task: "anything", availableBackends: ["codex.local", "copilot.local"] },
      emptyRates
    );
    expect(rec.backend).toBe("codex.local");
    expect(rec.rationale).toMatch(/first available/i);
    expect(rec.rationale).not.toMatch(/using the default/i);
  });

  it("reports no route when there are no available backends", () => {
    const emptyRates = { ...BUNDLED_SNAPSHOT, rates: [] };
    const rec = recommendBackend({ task: "anything", availableBackends: [] }, emptyRates);
    // No backend can be chosen; the recommendation falls back to the policy
    // default for the field but the rationale states nothing was routable.
    expect(rec.backend).toBe(BUNDLED_SNAPSHOT.policy.defaultBackend);
    expect(rec.rationale).toMatch(/No backends available/i);
    expect(rec.ranked).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    const input = { task: "Refactor the module", availableBackends: ALL };
    expect(recommendBackend(input, BUNDLED_SNAPSHOT)).toEqual(
      recommendBackend(input, BUNDLED_SNAPSHOT)
    );
  });
});
