import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";
import type { ModelRate, RoutingSnapshot } from "./routingSnapshot";

// The app-tier router (ADR-0092 D3 / packet 09 §3d): a pure function that picks a
// backend for a task from the routing snapshot + the available backends, optionally
// nudged by the user's own recent usage ("optimize your own subscriptions" — a SOFT
// tiebreak only, never cap-dodging). Deterministic and `[Provisional]`: the
// heuristics are tunable starting points, not a contract.

// Keywords that pull a task toward "complex" (prefer capability) or "light" (prefer
// cost). Matched as whole-ish words, case-insensitively.
const COMPLEX_HINTS = [
  "refactor",
  "architect",
  "design",
  "debug",
  "investigate",
  "root cause",
  "migrate",
  "optimize",
  "security",
  "concurrency",
  "race condition",
  "redesign",
  "rewrite"
];
const LIGHT_HINTS = [
  "rename",
  "typo",
  "format",
  "comment",
  "bump",
  "lint",
  "docstring",
  "readme",
  "changelog",
  "whitespace"
];

/** Estimate task complexity in `0..1` from keyword hints and length. Deterministic;
    a coarse routing signal, not a judgement. */
export function estimateComplexity(task: string): number {
  const text = task.toLowerCase();
  const complexHits = COMPLEX_HINTS.filter((hint) => text.includes(hint)).length;
  const lightHits = LIGHT_HINTS.filter((hint) => text.includes(hint)).length;

  // Longer asks skew more complex, saturating around ~600 chars.
  const lengthSignal = Math.min(task.length / 600, 1);
  // Each complex hint adds, each light hint subtracts; keyword signal dominates.
  const keywordSignal = 0.5 + 0.18 * complexHits - 0.18 * lightHits;

  const score = 0.6 * keywordSignal + 0.4 * lengthSignal;
  return Math.max(0, Math.min(1, score));
}

export interface RoutingInput {
  task: string;
  /** Backends the user can actually launch (allowlisted + installed). */
  availableBackends: AgentBackend[];
  /** Optional per-backend recent turn counts, for the subscription soft tiebreak. */
  recentTurnsByBackend?: Partial<Record<AgentBackend, number>>;
}

export interface RankedBackend {
  backend: AgentBackend;
  score: number;
}

export interface RoutingRecommendation {
  backend: AgentBackend;
  rationale: string;
  /** Every available backend, best first — for transparency / an override UI. */
  ranked: RankedBackend[];
  /** The estimated complexity that drove the cost-vs-capability choice. */
  complexity: number;
  /** True when the snapshot's source is not a live projection (e.g. bundled). */
  snapshotSource: string;
}

/**
 * Recommend a backend. Above the policy's complexity threshold the router prefers
 * capability (tie-broken by lower cost); below it, lower cost (tie-broken by higher
 * capability). The user's recent usage applies a small penalty so an otherwise-tied
 * choice leans toward a less-used subscription — never enough to override a clear
 * capability/cost winner.
 */
export function recommendBackend(
  input: RoutingInput,
  snapshot: RoutingSnapshot
): RoutingRecommendation {
  const available = snapshot.rates.filter((rate) =>
    input.availableBackends.includes(rate.backend)
  );
  const complexity = estimateComplexity(input.task);
  const preferCapability = complexity >= snapshot.policy.complexityThreshold;

  // No snapshot rate for any available backend → fall back honestly to the policy
  // default (or the first available), with a clear rationale.
  if (available.length === 0) {
    const fallback =
      input.availableBackends.find((backend) => backend === snapshot.policy.defaultBackend) ??
      input.availableBackends[0];
    return {
      backend: fallback ?? snapshot.policy.defaultBackend,
      rationale: "No routing data for the available backends — using the default.",
      ranked: fallback ? [{ backend: fallback, score: 0 }] : [],
      complexity,
      snapshotSource: snapshot.source
    };
  }

  const usagePenalty = (rate: ModelRate): number => {
    const turns = input.recentTurnsByBackend?.[rate.backend] ?? 0;
    // Capped + small: only breaks near-ties (tier weights are 10×/100×).
    return Math.min(turns, 10) * 0.5;
  };

  const score = (rate: ModelRate): number => {
    const base = preferCapability
      ? rate.capabilityTier * 100 - rate.costTier * 10
      : -rate.costTier * 100 + rate.capabilityTier * 10;
    return base - usagePenalty(rate);
  };

  const ranked: RankedBackend[] = available
    .map((rate) => ({ backend: rate.backend, score: score(rate) }))
    // Deterministic: by score desc, then backend id for a stable tiebreak.
    .sort((left, right) => right.score - left.score || (left.backend < right.backend ? -1 : 1));

  const winner = ranked[0]!.backend;
  const driver = preferCapability ? "most capable" : "lowest-cost";
  const nudged =
    (input.recentTurnsByBackend?.[winner] ?? 0) === 0 &&
    available.some((rate) => (input.recentTurnsByBackend?.[rate.backend] ?? 0) > 0);
  const rationale =
    `${preferCapability ? "Complex" : "Light"} task (complexity ${complexity.toFixed(2)})` +
    ` → ${driver} backend: ${backendLabel(winner)}` +
    (nudged ? "; leaning toward a less-used subscription." : ".");

  return { backend: winner, rationale, ranked, complexity, snapshotSource: snapshot.source };
}
