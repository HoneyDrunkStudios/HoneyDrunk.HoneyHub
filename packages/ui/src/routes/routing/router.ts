import type { AgentBackend, UsageProbeReport } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";
import { getPlan, type Plans } from "../../plans";
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

/** Real, probed plan headroom for one backend (the router's cap-awareness input). */
export interface BackendUsage {
  /** Remaining plan headroom as a percent, `0..100`. `100` = freshly reset / untouched;
      `0` = at the plan cap. Derived from the MOST-used probed window (the binding
      constraint), so a nearly-exhausted weekly limit governs the number even when the
      current session is fresh. A backend ABSENT from `usageByBackend` (not yet probed,
      or the probe found no parseable meter) is treated as neutral — the router falls
      back to the exact static heuristic for it, never breaking on missing data. */
  remainingPercent: number;
}

export interface RoutingInput {
  task: string;
  /** Backends the user can actually launch (allowlisted + installed). */
  availableBackends: AgentBackend[];
  /** Optional per-backend recent turn counts, for the subscription soft tiebreak. */
  recentTurnsByBackend?: Partial<Record<AgentBackend, number>>;
  /** Optional per-backend subscription plans (cost-optimizer input). A `flat`-rate
      backend is treated as effectively free in COST mode (see `recommendBackend`), so a
      sub the user already pays for can beat a cheaper-per-token metered backend. */
  plans?: Plans;
  /** Optional per-backend probed plan headroom (Wave E cap-awareness). When present it
      makes routing usage-aware: COST mode prefers the backend with MORE room left,
      CAPABILITY mode steers heavy work away from a backend approaching its cap. Absent
      entries leave that backend on the static heuristic (graceful fallback). */
  usageByBackend?: Partial<Record<AgentBackend, BackendUsage>>;
}

/**
 * Reduce a `usage_probe` report to the router's headroom input, or `undefined` when the
 * probe carried no parseable meter (a failed spawn, or an unrecognized panel layout).
 * Headroom is `100` minus the MOST-used window: the binding constraint is whichever
 * meter sits closest to its cap, so a 90%-used weekly limit governs even if the current
 * session is only 10% used. The report's `usedPercent` is already normalized to consumed
 * percent by the host probe (Claude reports "% used", Codex "% left" — both land as used).
 */
export function headroomFromReport(report: UsageProbeReport): BackendUsage | undefined {
  const used = report.windows
    .map((window) => window.usedPercent)
    .filter((percent): percent is number => typeof percent === "number" && Number.isFinite(percent));
  if (used.length === 0) {
    return undefined;
  }
  const maxUsed = Math.min(Math.max(Math.max(...used), 0), 100);
  return { remainingPercent: 100 - maxUsed };
}

export interface RankedBackend {
  backend: AgentBackend;
  score: number;
}

export interface RoutingRecommendation {
  backend: AgentBackend;
  rationale: string;
  /** The available backends that have a snapshot rate, best first (one entry per
      backend) — for transparency / an override UI. In the no-rate fallback this holds
      only the single chosen backend. */
  ranked: RankedBackend[];
  /** The estimated complexity that drove the cost-vs-capability choice. */
  complexity: number;
  /** The snapshot's provenance string (e.g. `bundled-default`), so a derived/stale
      source is legible to the caller. */
  snapshotSource: string;
}

/**
 * The honest fallback when no available backend has a snapshot rate. Prefers the
 * policy default when it is available; otherwise the first available backend — and
 * says which, so the rationale never claims "the default" when it isn't.
 */
function recommendFallback(
  input: RoutingInput,
  snapshot: RoutingSnapshot,
  complexity: number
): RoutingRecommendation {
  const defaultAvailable = input.availableBackends.includes(snapshot.policy.defaultBackend);
  const fallback = defaultAvailable
    ? snapshot.policy.defaultBackend
    : input.availableBackends[0];
  let rationale: string;
  if (fallback === undefined) {
    rationale = "No backends available to route to.";
  } else if (defaultAvailable) {
    rationale = "No routing data for the available backends, using the default.";
  } else {
    rationale = "No routing data and the default is unavailable, using the first available backend.";
  }
  return {
    backend: fallback ?? snapshot.policy.defaultBackend,
    rationale,
    ranked: fallback ? [{ backend: fallback, score: 0 }] : [],
    complexity,
    snapshotSource: snapshot.source
  };
}

/**
 * Recommend a backend. Above the policy's complexity threshold the router prefers
 * capability (tie-broken by lower cost); below it, lower cost (tie-broken by higher
 * capability). The user's recent usage applies a small penalty so an otherwise-tied
 * choice leans toward a less-used subscription — never enough to override a clear
 * capability/cost winner.
 *
 * When `usageByBackend` carries probed plan headroom, routing becomes cap-aware
 * (Wave E). In COST mode headroom is the primary tiebreak: a linear reward for room
 * left (max ~50 pts, above the ×10 capability tiebreak, below one ×100 cost tier) so a
 * freshly-reset backend beats a half-burned equal — decisive exactly when flat plans
 * collapse cost to zero. In CAPABILITY mode capability still leads, but an escalating
 * (cubic) penalty steers heavy work off a backend nearing its cap: negligible while
 * there is room, decisive only near exhaustion (crossover ~80% used), so a moderately
 * used top backend still wins but a nearly-exhausted one loses to a capable alternative
 * that has room. Backends with no probed headroom stay on the pure static heuristic.
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

  // No snapshot rate for any available backend → fall back honestly.
  if (available.length === 0) {
    return recommendFallback(input, snapshot, complexity);
  }

  // The cost tier a backend is scored with. In COST mode a `flat`-rate subscription the
  // user already pays for is treated as effectively free (costTier 0), so it can beat a
  // cheaper-per-token *metered* backend — the optimizer should prefer what's already
  // paid for. Metered/unset plans keep their snapshot costTier; capability mode is never
  // touched (its cost weight is only a tiebreak, and plans don't change capability).
  //
  // v1 honesty: we do NOT yet track real usage or the plan's cap, so "flat = free"
  // assumes the user still has headroom on the subscription. Cap-aware ramping (back off
  // as the plan approaches its limit) is a future refinement.
  const effectiveCostTier = (rate: ModelRate): number => {
    if (preferCapability) {
      return rate.costTier;
    }
    return getPlan(input.plans ?? {}, rate.backend).type === "flat" ? 0 : rate.costTier;
  };

  const scoreWith =
    (costTierOf: (rate: ModelRate) => number) =>
    (rate: ModelRate): number =>
      preferCapability
        ? rate.capabilityTier * 100 - costTierOf(rate) * 10
        : -costTierOf(rate) * 100 + rate.capabilityTier * 10;

  // The live score (plan-aware) and a plan-blind score (snapshot costTier only), so we
  // can tell whether a flat plan actually changed the winner for the rationale.
  const baseScore = scoreWith(effectiveCostTier);
  const baseScoreNoPlans = scoreWith((rate) => rate.costTier);

  const usagePenalty = (backend: AgentBackend): number => {
    // Clamp to [0, 10]: a negative count must never become a score *boost*, and the
    // cap keeps the penalty small (tier weights are 10×/100×), so it only breaks
    // near-ties.
    const turns = Math.min(Math.max(input.recentTurnsByBackend?.[backend] ?? 0, 0), 10);
    return turns * 0.5;
  };

  // --- Cap-aware headroom adjustment (Wave E) ---------------------------------------
  // COST mode: a linear reward for room left (equivalently, a penalty on percent USED),
  // capped near 50 — above the ×10 capability tiebreak so a freshly-reset backend beats
  // a half-burned equal, but below one ×100 cost tier so it never overrides a genuinely
  // cheaper backend. CAPABILITY mode: an escalating (cubic) penalty on percent used —
  // negligible with room, decisive only near the cap, sized so a moderately-used top
  // backend keeps its lead while a nearly-exhausted one yields to a capable alternative.
  const COST_HEADROOM_WEIGHT = 0.5; // per remaining percent (COST mode)
  const CAP_HEADROOM_MAX_PENALTY = 150; // at full exhaustion (CAPABILITY mode)
  const CAP_HEADROOM_EXPONENT = 3; // convexity: flat until the cap looms
  // Remaining headroom is treated as "just reset" only when essentially untouched — the
  // report carries no structured reset time (it lives in the raw `line` text only), so
  // near-zero usage is our honest proxy for a fresh window.
  const JUST_RESET_REMAINING = 95;
  const AMPLE_REMAINING = 60;

  const remainingOf = (backend: AgentBackend): number | undefined => {
    const remaining = input.usageByBackend?.[backend]?.remainingPercent;
    return remaining === undefined
      ? undefined
      : Math.min(Math.max(remaining, 0), 100);
  };
  const headroomDelta = (backend: AgentBackend): number => {
    const remaining = remainingOf(backend);
    if (remaining === undefined) {
      return 0; // no probed usage → neutral, keep the static heuristic
    }
    const usedFraction = (100 - remaining) / 100;
    if (preferCapability) {
      return -CAP_HEADROOM_MAX_PENALTY * usedFraction ** CAP_HEADROOM_EXPONENT;
    }
    return -COST_HEADROOM_WEIGHT * (100 - remaining);
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
  // Layered scores, each adding one signal, so every rationale note attributes to the
  // signal that actually moved the pick:
  //   baseScore                         plan + cost/capability tiers (no usage)
  //   scoreNoHeadroom = base − recentTurns   adds the recent-usage nudge
  //   finalScore      = scoreNoHeadroom + headroom   adds probed plan headroom
  const scoreNoHeadroom = (rate: ModelRate): number => baseScore(rate) - usagePenalty(rate.backend);
  const finalScore = (rate: ModelRate): number => scoreNoHeadroom(rate) + headroomDelta(rate.backend);

  const ranked: RankedBackend[] = [...candidates]
    .sort(order(finalScore))
    .map((rate) => ({ backend: rate.backend, score: finalScore(rate) }));

  const winner = ranked[0]!.backend;
  const winnerNoHeadroom = [...candidates].sort(order(scoreNoHeadroom))[0]!.backend;
  const winnerNoUsage = [...candidates].sort(order(baseScore))[0]!.backend;
  const winnerWithoutPlans = [...candidates].sort(order(baseScoreNoPlans))[0]!.backend;

  // Probed headroom shifted the pick when, without the headroom term, a different
  // backend would have won. The backend it displaced is the no-headroom winner.
  const headroomShifted = winner !== winnerNoHeadroom;
  const displaced = winnerNoHeadroom;
  // The recent-usage nudge note is shown only when that penalty (independent of
  // headroom) actually changed the winner, so the rationale never claims an influence
  // that did not happen.
  const nudged = winnerNoHeadroom !== winnerNoUsage;
  // Likewise, only credit a flat plan when treating it as free actually **flipped** the
  // winner — i.e. with snapshot cost tiers a different backend would have won. The
  // winner must itself be on a flat plan, so we never claim a flat plan "won" a backend
  // that has none.
  const planFlipped =
    !preferCapability &&
    winner !== winnerWithoutPlans &&
    getPlan(input.plans ?? {}, winner).type === "flat";

  const driver = preferCapability ? "most capable" : "lowest-cost";
  const winnerRemaining = remainingOf(winner);
  let suffix = ".";
  if (headroomShifted) {
    // Headroom drove the pick — say so in the operator's terms.
    if (preferCapability) {
      // Steered off a higher-capability backend that is running out of room.
      suffix = `; ${backendLabel(displaced)} is near its limit, so routing to ${backendLabel(
        winner
      )} which has headroom.`;
    } else {
      const justReset =
        winnerRemaining !== undefined && winnerRemaining >= JUST_RESET_REMAINING;
      suffix = `; favoring ${backendLabel(winner)}, which has more headroom left${
        justReset ? " (just reset)" : ""
      }.`;
    }
  } else if (planFlipped) {
    suffix = `; favoring your flat-rate ${backendLabel(winner)} plan.`;
  } else if (nudged) {
    suffix = "; leaning toward a less-used subscription.";
  } else if (winnerRemaining !== undefined && winnerRemaining >= AMPLE_REMAINING) {
    // Headroom did not change the pick, but the winner has plenty — affirm it so the
    // operator sees the choice is not backing into a cap.
    suffix = `; ${backendLabel(winner)} has ample headroom.`;
  }
  const rationale =
    `${preferCapability ? "Complex" : "Light"} task (complexity ${complexity.toFixed(2)})` +
    ` → ${driver} backend: ${backendLabel(winner)}` +
    suffix;

  return { backend: winner, rationale, ranked, complexity, snapshotSource: snapshot.source };
}
