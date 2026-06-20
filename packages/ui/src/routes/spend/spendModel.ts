import type {
  AgentBackend,
  UsageFidelity,
  UsageRollup,
  UsageSignal,
  UsageSummary
} from "@honeydrunk/honeyhub-types";
import { formatUsd } from "../../usageFormat";

// Pure helpers for the "your spend" view (ADR-0092 D2 cost view). The host
// computes the real summary; these only derive display strings and the offline
// mock's summary, so the formatting honesty (estimated never shown as a measured
// dollar) lives in one tested place.

// Re-export so existing importers (the view, the tests) keep their import path.
export { backendLabel } from "../../backends";

// Explicit rank maps so the mock/offline rollup order matches Rust's enum-`Ord`
// ordering (declaration order), not JS lexicographic order — "exact" < "derived" <
// "estimated" is NOT alphabetical, so a string sort would render same-backend rows
// in a different order than the host. Keep these in lockstep with the Rust enums.
const BACKEND_ORDER: Record<AgentBackend, number> = {
  "claude.local": 0,
  "codex.local": 1,
  "copilot.local": 2
};

const FIDELITY_ORDER: Record<UsageFidelity, number> = {
  exact: 0,
  derived: 1,
  estimated: 2
};

const FIDELITY_NOTES: Record<UsageFidelity, string> = {
  exact: "measured",
  derived: "rate-derived",
  estimated: "estimated"
};

export function fidelityNote(fidelity: UsageFidelity): string {
  return FIDELITY_NOTES[fidelity];
}

/** A rollup's cost cell: a fidelity-prefixed USD figure when the rollup carries a
    dollar cost, the premium-request count for an estimated backend that bills in
    requests, or a plain dash when neither is present. */
export function rollupCost(rollup: UsageRollup): string {
  if (rollup.totalUsd !== undefined) {
    return formatUsd(rollup.totalUsd, rollup.fidelity);
  }
  if (rollup.premiumRequests !== undefined) {
    const unit = rollup.premiumRequests === 1 ? "premium request" : "premium requests";
    return `${rollup.premiumRequests} ${unit}`;
  }
  return "-";
}

/** The grounded headline: a real dollar figure (exact + derived only), formatted
    to cents. `undefined` when no grounded spend was recorded, so the caller can
    show "no measured spend yet" rather than a misleading $0.00. */
export function groundedHeadline(summary: UsageSummary): string | undefined {
  if (summary.groundedTotalUsd === undefined) {
    return undefined;
  }
  return `$${summary.groundedTotalUsd.toFixed(2)}`;
}

/** True when there is anything to show — at least one rollup. An all-zero device
    has no rollups, so the view renders an empty state instead of a grid. */
export function hasSpend(summary: UsageSummary): boolean {
  return summary.rollups.length > 0;
}

/**
 * Aggregate raw usage signals into a device-wide summary — a TypeScript mirror of
 * the Rust `UsageSummary::from_signals`, used by the offline mock so the demo's
 * Spend view reflects the same rollup shape the host produces. Backends with
 * different fidelity stay in separate rollups; the grounded total sums exact +
 * derived USD only.
 */
export function summarizeUsage(signals: UsageSignal[], sessionCount: number): UsageSummary {
  const groups = new Map<string, UsageRollup>();
  for (const signal of signals) {
    const key = `${signal.backend}|${signal.fidelity}`;
    let rollup = groups.get(key);
    if (rollup === undefined) {
      rollup = {
        backend: signal.backend,
        fidelity: signal.fidelity,
        turnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: 0
      };
      groups.set(key, rollup);
    }
    rollup.turnCount += 1;
    rollup.inputTokens += signal.inputTokens ?? 0;
    rollup.outputTokens += signal.outputTokens ?? 0;
    rollup.totalTokens += signal.totalTokens ?? 0;
    rollup.durationMs += signal.durationMs ?? 0;
    if (signal.totalUsd !== undefined) {
      rollup.totalUsd = (rollup.totalUsd ?? 0) + signal.totalUsd;
    }
    // Estimated-only billing unit: only accumulate onto an estimated rollup, so a
    // stray count on an exact/derived signal never leaks into a per-backend row
    // (mirrors the Rust aggregator's root-cause guard).
    if (signal.premiumRequests !== undefined && signal.fidelity === "estimated") {
      rollup.premiumRequests = (rollup.premiumRequests ?? 0) + signal.premiumRequests;
    }
  }

  const rollups = [...groups.values()].sort((left, right) => {
    const backendDelta = BACKEND_ORDER[left.backend] - BACKEND_ORDER[right.backend];
    if (backendDelta !== 0) return backendDelta;
    return FIDELITY_ORDER[left.fidelity] - FIDELITY_ORDER[right.fidelity];
  });

  const grounded = rollups.filter(
    (rollup) => rollup.fidelity === "exact" || rollup.fidelity === "derived"
  );
  const anyGroundedUsd = grounded.some((rollup) => rollup.totalUsd !== undefined);
  const groundedTotalUsd = anyGroundedUsd
    ? grounded.reduce((sum, rollup) => sum + (rollup.totalUsd ?? 0), 0)
    : undefined;
  // Premium requests are an estimated-backend unit; restrict the total to estimated
  // rollups (mirrors the Rust aggregator) so a stray count can't inflate it.
  const totalPremiumRequests = rollups
    .filter((rollup) => rollup.fidelity === "estimated")
    .reduce((sum, rollup) => sum + (rollup.premiumRequests ?? 0), 0);

  return {
    sessionCount,
    totalTurns: rollups.reduce((sum, rollup) => sum + rollup.turnCount, 0),
    rollups,
    // Omit (rather than set undefined) so the optional field stays absent under
    // exactOptionalPropertyTypes — matching the bridge's `skip_serializing_if`.
    ...(groundedTotalUsd === undefined ? {} : { groundedTotalUsd }),
    totalPremiumRequests
  };
}
