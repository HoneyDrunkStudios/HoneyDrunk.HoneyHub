import type { PolicyHint, PolicyHintSeverity } from "@honeydrunk/honeyhub-types";

// Pure display helpers for the coaching surface (ADR-0092 D4 / packet 09 §3e). The
// host runs the rules engine; these only order and label the advisories for the UI.

// Warnings surface above info; Block never occurs in the local-v1 advisory-only
// posture (the engine never emits it) but is ranked first defensively.
const SEVERITY_RANK: Record<PolicyHintSeverity, number> = {
  block: 0,
  warning: 1,
  info: 2
};

export function severityLabel(severity: PolicyHintSeverity): string {
  if (severity === "warning") return "Warning";
  if (severity === "block") return "Action";
  return "Info";
}

const HINT_TITLES: Record<string, string> = {
  stale_session: "Long session",
  high_cost_session: "High spend",
  estimate_only_spend: "Estimated usage"
};

/** A short heading for a hint, derived from its rule code (the full guidance is the
    hint's own `message`). Falls back to a humanized code for an unknown rule. */
export function hintTitle(code: string): string {
  return HINT_TITLES[code] ?? code.replaceAll("_", " ");
}

/** Order advisories by severity (warnings first), then by recency, then by a stable
    key so the list never reorders arbitrarily between identical snapshots. */
export function sortHints(hints: PolicyHint[]): PolicyHint[] {
  return [...hints].sort((left, right) => {
    const severityDelta = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severityDelta !== 0) return severityDelta;
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}
