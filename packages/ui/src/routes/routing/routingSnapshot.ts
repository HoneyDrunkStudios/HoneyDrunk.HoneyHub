import type { AgentBackend } from "@honeydrunk/honeyhub-types";

// The routing snapshot (ADR-0092 D3 / packet 09 §3d): the cost-rate + routing-policy
// projection the app-tier router reads to pick a backend. v1 consumes a **bundled
// default** (fully offline; no fetch infrastructure) — cost rates move only a few
// times a year, so a HoneyHub release easily keeps pace, and the `derived` fidelity
// tag already makes any drift visible. HoneyHub owns this schema as the consumer
// contract; HoneyDrunk.AI producing to it (and fetch-and-cache delivery) are tracked
// follow-ups. The tiers are coarse routing signals, NOT the per-token USD (that is
// computed at runtime from real usage); everything here is `[Provisional]`.

export interface ModelRate {
  backend: AgentBackend;
  modelLabel: string;
  /** Coarse cost signal for routing (1 = cheapest … higher = pricier). */
  costTier: number;
  /** Coarse capability signal (1 = light tasks … higher = more capable). */
  capabilityTier: number;
}

export interface RoutingPolicy {
  /** The backend chosen when nothing else discriminates. */
  defaultBackend: AgentBackend;
  /**
   * Estimated task complexity (0..1) at or above which the router prefers
   * **capability** over **cost**; below it, it prefers the cheapest capable backend.
   */
  complexityThreshold: number;
}

export interface RoutingSnapshot {
  /** When the snapshot was produced (RFC3339). */
  generatedAt: string;
  /** Provenance, e.g. `bundled-default` — so a stale/derived source is legible. */
  source: string;
  rates: ModelRate[];
  policy: RoutingPolicy;
}

/**
 * The v1 bundled default snapshot. Tiers are deliberate, defensible starting points
 * (`[Provisional]`): Claude is the most capable and the priciest (exact billing),
 * Codex sits in the middle (derived USD), Copilot is the lightest-cost lane (premium
 * requests). Tune via dogfooding without an ADR.
 */
export const BUNDLED_SNAPSHOT: RoutingSnapshot = {
  generatedAt: "2026-06-08T00:00:00Z",
  source: "bundled-default",
  rates: [
    { backend: "claude.local", modelLabel: "claude", costTier: 3, capabilityTier: 3 },
    { backend: "codex.local", modelLabel: "codex", costTier: 2, capabilityTier: 2 },
    { backend: "copilot.local", modelLabel: "copilot", costTier: 1, capabilityTier: 2 }
  ],
  policy: {
    defaultBackend: "claude.local",
    complexityThreshold: 0.5
  }
};
