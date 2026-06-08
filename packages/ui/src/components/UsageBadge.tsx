import type { UsageFidelity, UsageSignal } from "@honeydrunk/honeyhub-types";

// ADR-0092 D2 [Firm]: the UI must visually distinguish exact / derived / estimated
// and never render an estimate as an exact number. Each fidelity gets its own
// prefix and an always-visible qualifier tag, so no figure can be read as exact
// when it is not.
const FIDELITY: Record<UsageFidelity, { prefix: string; label: string }> = {
  exact: { prefix: "$", label: "exact" },
  derived: { prefix: "≈$", label: "derived" },
  estimated: { prefix: "~$", label: "estimated" }
};

export function UsageBadge({ usage }: { usage: UsageSignal }) {
  const fidelity = FIDELITY[usage.fidelity];
  const usd =
    usage.totalUsd !== undefined
      ? `${fidelity.prefix}${usage.totalUsd.toFixed(4)}`
      : undefined;

  return (
    <span
      className={`usage-badge fidelity-${usage.fidelity}`}
      aria-label={`Usage (${fidelity.label})`}
    >
      {usd !== undefined && <strong className="usage-usd">{usd}</strong>}
      {usage.totalTokens !== undefined && (
        <span className="usage-tokens">{usage.totalTokens} tok</span>
      )}
      <span className="fidelity-tag">{fidelity.label}</span>
    </span>
  );
}
