import type { UsageSignal } from "@honeydrunk/honeyhub-types";
import { formatUsd } from "../usageFormat";

// ADR-0092 D2 [Firm]: the UI must visually distinguish exact / derived / estimated
// and never render an estimate as an exact number. The fidelity-aware USD prefix
// lives in `usageFormat` (shared with the diagnostics panel); the always-visible
// fidelity tag below makes the band explicit.
export function UsageBadge({ usage }: Readonly<{ usage: UsageSignal }>) {
  const usd =
    usage.totalUsd === undefined ? undefined : formatUsd(usage.totalUsd, usage.fidelity);

  return (
    <span
      className={`usage-badge fidelity-${usage.fidelity}`}
      aria-label={`Usage (${usage.fidelity})`}
    >
      {usd !== undefined && <strong className="usage-usd">{usd}</strong>}
      {usage.totalTokens !== undefined && (
        <span className="usage-tokens">{usage.totalTokens} tok</span>
      )}
      <span className="fidelity-tag">{usage.fidelity}</span>
    </span>
  );
}
