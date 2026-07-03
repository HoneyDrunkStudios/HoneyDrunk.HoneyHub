import type { AgentBackend, BackendModel } from "@honeydrunk/honeyhub-types";
import type { BackendPlan } from "../../plans";
import { usdPrefix } from "../../usageFormat";

// Pre-send cost estimate for the composer (ADR-0092 D2 posture: estimates are ranges
// with honest provenance, never a fake-precise number). Two estimators combine:
//  - an input FLOOR: what sending this prompt costs in input tokens alone, from the
//    catalog's per-model rates. Output tokens dominate real spend and don't exist
//    yet, so this is a lower bound, labeled as such.
//  - a HISTORY projection: median / p90 of what similar past chats (same backend +
//    model) actually cost, from the locally saved chat records. A far better
//    predictor for agent runs than any token math.
// A flat-plan backend short-circuits to "included" — but only for a RESOLVED,
// non-metered model: metered models (usage credits / API billing) cost real dollars
// regardless of the plan, and an unresolved model must never be claimed as free.

/** The cost signal shown under the composer, or undefined when there is nothing
    honest to say (unknown model, no rate, no history). */
export type CostEstimate =
  | { kind: "included" }
  | {
      kind: "estimate";
      /** Input-side floor for sending this prompt, in USD (absent without a rate
          or for an empty prompt). */
      inputFloorUsd?: number;
      /** Projection from similar past chats (absent without matching history). */
      history?: { typicalUsd: number; highUsd: number; sampleSize: number };
    };

/** The slice of a saved chat the estimator needs (matches `ChatSummary`). */
export interface CostHistoryEntry {
  backend?: AgentBackend | undefined;
  model?: string | undefined;
  totalUsd: number;
}

/** Rough prompt-side token count. The chars/4 heuristic matches the copilot
    adapter's estimator; real tokenizers are false precision here since output
    tokens dominate the bill anyway. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** True when a recorded model id refers to the given catalog id. Claude records the
    served full id (e.g. `claude-opus-4-8`) while the catalog holds the alias
    (`opus`), so an alias matches as a whole dash-separated segment — never by bare
    substring, which would let `gpt-5` swallow `gpt-5-codex` chats. */
export function modelIdMatches(recorded: string | undefined, catalogId: string): boolean {
  if (recorded === undefined) {
    return false;
  }
  return recorded === catalogId || recorded.split("-").includes(catalogId);
}

/** Resolve a picked model id (alias, exact id, or a custom full id like
    `claude-fable-5`) against the catalog, so billing flags are honored even when
    the user typed the served id instead of the alias. */
export function resolveCatalogModel(
  models: BackendModel[],
  modelId: string | undefined
): BackendModel | undefined {
  if (modelId === undefined) {
    return undefined;
  }
  return (
    models.find((entry) => entry.id === modelId) ??
    models.find((entry) => modelIdMatches(modelId, entry.id))
  );
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] as number;
}

export interface EstimateInputs {
  /** The composer text about to be sent. */
  task: string;
  backend: AgentBackend;
  /** The resolved model, from the catalog; undefined = CLI default / unknown. */
  model: BackendModel | undefined;
  /** The user's plan for this backend (default `{ type: "unset" }`). */
  plan: BackendPlan;
  /** Saved chat summaries (order is irrelevant). */
  history: CostHistoryEntry[];
}

/** Estimate what sending the composer's message will cost, or undefined when
    nothing honest can be said. */
export function estimateRunCost({
  task,
  backend,
  model,
  plan,
  history
}: EstimateInputs): CostEstimate | undefined {
  // Flat subscription: marginal cost is $0 until the cap — exactly what the Plans
  // model encodes. Claimed only for a KNOWN, non-metered model: an unresolved model
  // could be the usage-credit-billed one, so it gets no free-of-charge promise.
  if (plan.type === "flat" && model !== undefined && model.metered !== true) {
    return { kind: "included" };
  }
  if (model === undefined) {
    return undefined;
  }

  const rate = model.pricing;
  const floor =
    rate === undefined ? 0 : (approximateTokens(task) / 1_000_000) * rate.inputUsdPerMtok;

  const costs = history
    .filter(
      (entry) => entry.backend === backend && entry.totalUsd > 0 && modelIdMatches(entry.model, model.id)
    )
    .map((entry) => entry.totalUsd)
    .sort((a, b) => a - b);

  if (floor <= 0 && costs.length === 0) {
    return undefined;
  }
  return {
    kind: "estimate",
    ...(floor > 0 ? { inputFloorUsd: floor } : {}),
    ...(costs.length === 0
      ? {}
      : {
          history: {
            typicalUsd: percentile(costs, 0.5),
            highUsd: percentile(costs, 0.9),
            sampleSize: costs.length
          }
        })
  };
}

/** Estimated-money digits with enough precision that sub-cent costs don't read as
    zero. Callers prefix with `usdPrefix("estimated")` so the ~$ vocabulary stays
    centralized in usageFormat.ts. */
export function formatEstimateUsd(value: number): string {
  const prefix = usdPrefix("estimated");
  if (value >= 0.1) {
    return `${prefix}${value.toFixed(2)}`;
  }
  return `${prefix}${value.toFixed(value >= 0.01 ? 3 : 4)}`;
}

/** One-line human summary of an estimate, or undefined when there is none. */
export function describeEstimate(estimate: CostEstimate | undefined): string | undefined {
  if (estimate === undefined) {
    return undefined;
  }
  if (estimate.kind === "included") {
    return "Included in your plan";
  }
  const parts: string[] = [];
  if (estimate.history !== undefined) {
    const { typicalUsd, highUsd, sampleSize } = estimate.history;
    parts.push(
      `${formatEstimateUsd(typicalUsd)} typical · up to ${formatEstimateUsd(highUsd)} (${sampleSize} similar ${
        sampleSize === 1 ? "chat" : "chats"
      })`
    );
  }
  if (estimate.inputFloorUsd !== undefined) {
    parts.push(`≥ ${formatEstimateUsd(estimate.inputFloorUsd)} to send`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}
