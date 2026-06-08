import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";
import type { ModelRate, RoutingSnapshot } from "./routingSnapshot";

// The app-tier router (ADR-0092 D3 / packet 09 §3d): a pure function that picks a
// backend for a task from the routing snapshot + the available backends, optionally
// nudged by the user's own recent usage ("optimize your own subscriptions" — a SOFT
// tiebreak only, never cap-dodging). Deterministic and `[Provisional]`: the
// heuristics are tunable starting points, not a contract.

// Keywords that pull a task toward "complex" (prefer capability) or "light" (prefer
// cost). Matched as case-insensitive **substrings** — a coarse signal, so a partial
// match (e.g. "format" in "reformat") counts; precise word boundaries are not needed.
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
  /** The snapshot's provenance string (e.g. `bundled-default`), so a derived/stale
      source is legible to the caller. */
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

  const baseScore = (rate: ModelRate): number =>
    preferCapability
      ? rate.capabilityTier * 100 - rate.costTier * 10
      : -rate.costTier * 100 + rate.capabilityTier * 10;

  const usagePenalty = (backend: AgentBackend): number => {
    // Clamp to [0, 10]: a negative count must never become a score *boost*, and the
    // cap keeps the penalty small (tier weights are 10×/100×), so it only breaks
    // near-ties.
    const turns = Math.min(Math.max(input.recentTurnsByBackend?.[backend] ?? 0, 0), 10);
    return turns * 0.5;
  };

  // Reduce to the best rate **per backend** (a snapshot could carry several models
  // for one backend), so `ranked` has exactly one entry per backend and no duplicate
  // can distort the winner. The usage penalty is per-backend, so it does not change
  // which rate within a backend is best — pick by base score.
  const bestByBackend = new Map<AgentBackend, ModelRate>();
  for (const rate of available) {
    const existing = bestByBackend.get(rate.backend);
    if (existing === undefined || baseScore(rate) > baseScore(existing)) {
      bestByBackend.set(rate.backend, rate);
    }
  }
  const candidates = [...bestByBackend.values()];

  // Deterministic ordering: by final score desc, then backend id for a stable tiebreak.
  const order = (scoreOf: (rate: ModelRate) => number) => (left: ModelRate, right: ModelRate) =>
    scoreOf(right) - scoreOf(left) || (left.backend < right.backend ? -1 : 1);
  const finalScore = (rate: ModelRate): number => baseScore(rate) - usagePenalty(rate.backend);

  const ranked: RankedBackend[] = [...candidates]
    .sort(order(finalScore))
    .map((rate) => ({ backend: rate.backend, score: finalScore(rate) }));

  const winner = ranked[0]!.backend;
  // The nudge note is shown only when the usage penalty actually **changed** the
  // winner — i.e. without it a different backend would have won — so the rationale
  // never claims an influence that did not happen.
  const winnerWithoutUsage = [...candidates].sort(order(baseScore))[0]!.backend;
  const nudged = winner !== winnerWithoutUsage;

  const driver = preferCapability ? "most capable" : "lowest-cost";
  const rationale =
    `${preferCapability ? "Complex" : "Light"} task (complexity ${complexity.toFixed(2)})` +
    ` → ${driver} backend: ${backendLabel(winner)}` +
    (nudged ? "; leaning toward a less-used subscription." : ".");

  return { backend: winner, rationale, ranked, complexity, snapshotSource: snapshot.source };
}
