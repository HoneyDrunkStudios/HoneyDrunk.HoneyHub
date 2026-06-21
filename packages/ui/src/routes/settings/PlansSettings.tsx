import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";
import { NumberField } from "../../components/NumberField";
import { getPlan, setPlan, type PlanType, type Plans } from "../../plans";
import { allBackends } from "../../settingsModel";

// Why we ask: if you pay a flat monthly fee for a provider, extra requests on it are
// effectively free until you hit its cap — so "Optimize cost" should prefer it over a
// cheaper-per-token model. This panel collects, per backend, whether you're on a
// flat-rate sub, metered (pay per token), or haven't said (the default — changes
// nothing). Everything is optional. The same UI backs Settings and the onboarding step.

const WHY_PLANS =
  "If you pay a flat monthly fee for a provider, extra requests are effectively free " +
  "until you hit its cap, so the optimizer should prefer it over a cheaper-per-token " +
  "model. Tell us your plans so 'Optimize cost' reflects what you actually pay. " +
  "Optional: leave blank to skip.";

export interface PlansSettingsProps {
  plans: Plans;
  onChange: (next: Plans) => void;
  /** Heading text — Settings uses a section legend; onboarding can override/hide it. */
  heading?: string;
}

/** Per-backend plan editor. A compact row per configurable backend: a plan-type select
    and, for flat-rate, a monthly-$ input. Persists via the caller's `onChange`. */
export function PlansSettings({ plans, onChange, heading = "Subscription plans" }: Readonly<PlansSettingsProps>) {
  const setType = (backend: AgentBackend, type: PlanType) => {
    const current = getPlan(plans, backend);
    // Keep a known monthly amount when staying/becoming flat; drop it otherwise.
    const nextPlan =
      type === "flat"
        ? { type, ...(current.monthlyUsd === undefined ? {} : { monthlyUsd: current.monthlyUsd }) }
        : { type };
    onChange(setPlan(plans, backend, nextPlan));
  };

  const setMonthly = (backend: AgentBackend, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === "" ? undefined : Number(trimmed);
    const monthlyUsd =
      value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
    onChange(
      setPlan(plans, backend, {
        type: "flat",
        ...(monthlyUsd === undefined ? {} : { monthlyUsd })
      })
    );
  };

  return (
    <fieldset className="plans-settings">
      <legend>
        {heading}
        <button type="button" className="info-tip" aria-label="Why we ask" title={WHY_PLANS}>
          ?
        </button>
      </legend>
      <p className="plans-why">{WHY_PLANS}</p>
      <ul className="plan-rows" aria-label="Subscription plans">
        {allBackends.map((backend) => {
          const plan = getPlan(plans, backend);
          return (
            <li key={backend} className="plan-row">
              <span className="plan-backend">{backendLabel(backend)}</span>
              <select
                className="chip-select"
                aria-label={`${backendLabel(backend)} plan`}
                value={plan.type}
                onChange={(event) => setType(backend, event.target.value as PlanType)}
              >
                <option value="unset">Not set</option>
                <option value="flat">Flat-rate subscription</option>
                <option value="metered">Metered (pay per token)</option>
              </select>
              {plan.type === "flat" && (
                <NumberField
                  className="plan-monthly"
                  min={0}
                  step={5}
                  ariaLabel={`${backendLabel(backend)} monthly cost (USD)`}
                  placeholder="$ / month"
                  value={plan.monthlyUsd === undefined ? "" : String(plan.monthlyUsd)}
                  onChange={(monthly) => setMonthly(backend, monthly)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
