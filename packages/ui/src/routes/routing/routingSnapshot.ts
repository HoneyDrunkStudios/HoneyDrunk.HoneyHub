import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import bundledSnapshot from "./routingSnapshot.bundled.json";

// The routing snapshot (ADR-0092 D3 / packet 09 §3d): the cost-rate + routing-policy
// projection the app-tier router reads to pick a backend. The rates/policy live in a
// **data artifact** (`routingSnapshot.bundled.json`), loaded through `loadRoutingSnapshot`
// — they are NOT hardcoded in application code (invariant 45, amended for the
// local-first HoneyHub Node: it consumes a synced-snapshot projection of the
// canonical App-Config-sourced/AI-published policy rather than calling Azure App
// Config at runtime, which it cannot do offline). v1 loads the bundled JSON; a future
// version fetches+caches the published projection without changing callers. The tiers
// are coarse routing signals, NOT the per-token USD (that is computed at runtime from
// real usage); everything here is `[Provisional]`.

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
 * Load the routing snapshot. This is the **consumption seam** (ADR-0092 D3): it
 * behaves like fetching the snapshot from the canonical (App-Config-sourced,
 * AI-published) source — in v1 it loads the bundled JSON projection synchronously
 * (fully offline, no fetch infrastructure), and a later version can fetch+cache the
 * published projection behind this same function without touching callers. The data
 * lives in `routingSnapshot.bundled.json`, never as constants in application code
 * (invariant 45, amended for the local-first HoneyHub Node).
 *
 * The bundled tiers are deliberate, defensible starting points (`[Provisional]`):
 * Claude is most capable and priciest (exact billing), Codex sits in the middle
 * (derived USD), Copilot is the lightest-cost lane (premium requests). Tune by
 * republishing the projection — no code change.
 */
export function loadRoutingSnapshot(): RoutingSnapshot {
  return bundledSnapshot as RoutingSnapshot;
}
