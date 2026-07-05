import { describe, expect, it } from "vitest";
import type { AgentBackend, UsageProbeReport } from "@honeydrunk/honeyhub-types";
import { estimateComplexity, headroomFromReport, recommendBackend } from "./router";
import { loadRoutingSnapshot } from "./routingSnapshot";

const ALL: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];
// The loaded snapshot (v1: the bundled JSON projection) under test.
const BUNDLED_SNAPSHOT = loadRoutingSnapshot();

/** Build a scripted usage_probe report with the given per-window "% used" values (an
    `undefined` entry stands for a line the host could not parse a percent from). */
function usageReport(backend: AgentBackend, used: (number | undefined)[]): UsageProbeReport {
  return {
    backend,
    ok: true,
    windows: used.map((percent, index) => ({
      line: `window ${index}`,
      ...(percent === undefined ? {} : { usedPercent: percent })
    })),
    raw: "",
    capturedAt: "2026-07-05T00:00:00Z"
  };
}

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

  describe("headroom-aware cost optimization (Wave E)", () => {
    // Two flat plans collapse cost to 0 for both, so without usage Claude wins the light
    // task on the capability tiebreak — the operator's confusing case.
    const FLAT_BOTH = {
      "claude.local": { type: "flat" as const, monthlyUsd: 20 },
      "codex.local": { type: "flat" as const, monthlyUsd: 20 }
    };
    const LIGHT_TASK = "Fix a typo and reformat a comment";

    it("flips a light task to the freshly-reset backend when flat plans collapse cost", () => {
      // Codex just reset (100% headroom); Claude is half-burned (50%). With both on flat
      // plans, cost is a wash, so headroom decides: Codex should win.
      const rec = recommendBackend(
        {
          task: LIGHT_TASK,
          availableBackends: ["claude.local", "codex.local"],
          plans: FLAT_BOTH,
          usageByBackend: {
            "codex.local": { remainingPercent: 100 },
            "claude.local": { remainingPercent: 50 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("codex.local");
      expect(rec.rationale).toMatch(/more headroom/);
      expect(rec.rationale).toMatch(/just reset/);
      // Codex leads the ranking now.
      expect(rec.ranked[0]?.backend).toBe("codex.local");
    });

    it("reproduces today's static pick exactly when usage data is absent", () => {
      const withUsage = {
        task: LIGHT_TASK,
        availableBackends: ["claude.local", "codex.local"] as AgentBackend[],
        plans: FLAT_BOTH
      };
      const rec = recommendBackend(withUsage, BUNDLED_SNAPSHOT);
      // No probed headroom → the flat-plan tie falls to the capability tiebreak (Claude),
      // exactly as before Wave E, and no headroom wording appears.
      expect(rec.backend).toBe("claude.local");
      expect(rec.rationale).not.toMatch(/headroom/);
    });

    it("leaves an UNPROBED backend neutral (absent usage never loses a static winner)", () => {
      // Only Codex is probed (fresh). Claude is unprobed → treated as neutral, so it keeps
      // its capability-tiebreak win; a fresh probe alone does not beat an unknown backend.
      const rec = recommendBackend(
        {
          task: LIGHT_TASK,
          availableBackends: ["claude.local", "codex.local"],
          plans: FLAT_BOTH,
          usageByBackend: { "codex.local": { remainingPercent: 100 } }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("claude.local");
      expect(rec.rationale).not.toMatch(/more headroom/);
    });

    it("never lets headroom override a genuinely cheaper backend", () => {
      // Metered plans keep the real cost gap (Codex tier 1 vs Claude tier 3). Even with
      // Codex nearly exhausted and Claude fresh, the cost primary (×100) still wins Codex
      // the light task — headroom (max ~50) can only break a cost tie.
      const rec = recommendBackend(
        {
          task: LIGHT_TASK,
          availableBackends: ["claude.local", "codex.local"],
          usageByBackend: {
            "codex.local": { remainingPercent: 5 },
            "claude.local": { remainingPercent: 100 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("codex.local");
    });
  });

  describe("headroom-aware capability routing (Wave E)", () => {
    const COMPLEX_TASK =
      "Redesign and refactor the concurrency model; debug the race condition";

    it("routes complex work off a nearly-exhausted top backend to a capable one with room", () => {
      // Claude leads on capability but is at 95% used; Codex (still capable) has room.
      const rec = recommendBackend(
        {
          task: COMPLEX_TASK,
          availableBackends: ["claude.local", "codex.local"],
          usageByBackend: {
            "claude.local": { remainingPercent: 5 },
            "codex.local": { remainingPercent: 90 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("codex.local");
      expect(rec.rationale).toMatch(/near its limit/);
      expect(rec.rationale).toMatch(/Codex/);
    });

    it("keeps a MODERATELY-used top backend on complex work (penalty stays negligible)", () => {
      // Claude at 50% used is not near its cap, so it still wins the complex task.
      const rec = recommendBackend(
        {
          task: COMPLEX_TASK,
          availableBackends: ["claude.local", "codex.local"],
          usageByBackend: {
            "claude.local": { remainingPercent: 50 },
            "codex.local": { remainingPercent: 90 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("claude.local");
      expect(rec.rationale).not.toMatch(/near its limit/);
    });

    it("affirms ample headroom when the top backend wins with room to spare", () => {
      const rec = recommendBackend(
        {
          task: COMPLEX_TASK,
          availableBackends: ["claude.local", "codex.local"],
          usageByBackend: {
            "claude.local": { remainingPercent: 80 },
            "codex.local": { remainingPercent: 70 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("claude.local");
      expect(rec.rationale).toMatch(/ample headroom/);
    });

    it("keeps the top backend when EVERY capable option is nearly exhausted", () => {
      // Both near their caps → capability still leads (no roomy alternative to route to).
      const rec = recommendBackend(
        {
          task: COMPLEX_TASK,
          availableBackends: ["claude.local", "codex.local"],
          usageByBackend: {
            "claude.local": { remainingPercent: 8 },
            "codex.local": { remainingPercent: 8 }
          }
        },
        BUNDLED_SNAPSHOT
      );
      expect(rec.backend).toBe("claude.local");
      expect(rec.rationale).not.toMatch(/near its limit/);
    });
  });
});

describe("headroomFromReport", () => {
  it("takes the MOST-used window as the binding constraint", () => {
    // session 34% / week 61% / model 12% → the 61%-used window governs → 39% remaining.
    const usage = headroomFromReport(usageReport("claude.local", [34, 61, 12]));
    expect(usage).toEqual({ remainingPercent: 39 });
  });

  it("ignores windows with no parsed percent", () => {
    const usage = headroomFromReport(usageReport("codex.local", [undefined, 80, undefined]));
    expect(usage).toEqual({ remainingPercent: 20 });
  });

  it("returns undefined when no window carried a percent (unparseable / failed probe)", () => {
    expect(headroomFromReport(usageReport("claude.local", []))).toBeUndefined();
    expect(headroomFromReport(usageReport("claude.local", [undefined]))).toBeUndefined();
    const failed: UsageProbeReport = {
      backend: "codex.local",
      ok: false,
      windows: [],
      raw: "could not launch codex",
      capturedAt: "2026-07-05T00:00:00Z"
    };
    expect(headroomFromReport(failed)).toBeUndefined();
  });
});
