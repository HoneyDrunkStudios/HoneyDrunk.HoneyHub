import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { allBackends } from "./settingsModel";

// Persisted subscription plans (cost-optimizer input). If the user pays a flat
// monthly fee for a provider (e.g. a Claude/Copilot subscription), extra requests on
// it are effectively free until they hit the plan's cap — so the cost optimizer should
// prefer that provider over a cheaper-per-token *metered* one. This local-only model
// captures, per backend, whether the user is on a flat-rate sub, metered (pay per
// token), or hasn't told us ("unset" — the default, which changes nothing in routing).
// Everything is optional: a fresh cockpit has no plans and routes exactly as before.

const STORAGE_KEY = "honeyhub.plans.v1";

export type PlanType = "flat" | "metered" | "unset";

export interface BackendPlan {
  type: PlanType;
  /** The flat monthly fee, when known (flat plans only). Informational — routing only
      keys off `type`, not the amount. */
  monthlyUsd?: number;
}

/** Per-backend plan. An absent backend means "unset" (the default). */
export type Plans = Partial<Record<AgentBackend, BackendPlan>>;

const DEFAULT_PLAN: BackendPlan = { type: "unset" };

function isAgentBackend(value: unknown): value is AgentBackend {
  return typeof value === "string" && (allBackends as string[]).includes(value);
}

function isPlanType(value: unknown): value is PlanType {
  return value === "flat" || value === "metered" || value === "unset";
}

/** Parse a single persisted plan, tolerating junk. An unknown/blank shape collapses to
    the unset default; a non-finite/negative monthlyUsd is dropped (kept absent). */
function parsePlan(value: unknown): BackendPlan {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_PLAN };
  }
  const record = value as Record<string, unknown>;
  const type: PlanType = isPlanType(record.type) ? record.type : "unset";
  const plan: BackendPlan = { type };
  const monthly = record.monthlyUsd;
  if (typeof monthly === "number" && Number.isFinite(monthly) && monthly >= 0) {
    plan.monthlyUsd = monthly;
  }
  return plan;
}

/** Load saved plans, tolerating missing/corrupt/legacy storage by falling back to an
    empty map (everything unset). Unknown backends and malformed entries are dropped.
    Never throws. */
export function loadPlans(): Plans {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const result: Plans = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAgentBackend(key)) {
        result[key] = parsePlan(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Persist plans. Never throws (storage may be unavailable/full). */
export function savePlans(plans: Plans): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(plans));
  } catch {
    // Best-effort: a cockpit that can't persist still works for the session.
  }
}

/** The plan for a backend, defaulting to `{ type: "unset" }` when none is set. */
export function getPlan(plans: Plans, backend: AgentBackend): BackendPlan {
  return plans[backend] ?? { ...DEFAULT_PLAN };
}

/** Set (or clear) the plan for a backend, returning a new map. An "unset" plan with no
    amount is stored as an absent entry so the map reads as "nothing configured". */
export function setPlan(plans: Plans, backend: AgentBackend, plan: BackendPlan): Plans {
  const next: Plans = { ...plans };
  if (plan.type === "unset" && plan.monthlyUsd === undefined) {
    delete next[backend];
  } else {
    next[backend] = plan;
  }
  return next;
}
