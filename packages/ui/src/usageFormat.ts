import type { UsageFidelity } from "@honeydrunk/honeyhub-types";

// Shared fidelity-aware USD formatting (ADR-0092 D2): exact / derived / estimated
// each get a distinct prefix, so an estimate is never shown as an exact figure.
// Centralized so the usage badge and the diagnostics panel can never diverge.

export function usdPrefix(fidelity: UsageFidelity | undefined): string {
  if (fidelity === "estimated") return "~$";
  if (fidelity === "derived") return "≈$";
  return "$";
}

export function formatUsd(usd: number, fidelity: UsageFidelity | undefined): string {
  return `${usdPrefix(fidelity)}${usd.toFixed(4)}`;
}
