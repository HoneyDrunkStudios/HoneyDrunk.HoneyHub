import { useState } from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import type { Plans } from "../../plans";
import type { WireClient } from "../../wire/client";
import { ConnectPhone } from "../settings/ConnectPhone";
import { PlansSettings } from "../settings/PlansSettings";
import { ProviderOnboarding } from "./ProviderOnboarding";
import { RepoLocationsStep } from "./RepoLocationsStep";

export interface OnboardingProps {
  client: WireClient;
  catalog: BackendCapability[];
  detecting: boolean;
  initialEnabled: AgentBackend[];
  initialRoots: string[];
  /** A prior plan selection to seed from (e.g. re-running onboarding). */
  initialPlans: Plans;
  /** Commit the chosen providers + repo locations + plans and enter the cockpit. */
  onComplete: (enabled: AgentBackend[], roots: string[], plans: Plans) => void;
}

/** First-run flow: pick providers (1), where your repos live (2), your subscription
    plans (3, optional), then optionally connect a phone (4). Every step after providers
    is skippable — they are conveniences, not requirements. */
export function Onboarding({
  client,
  catalog,
  detecting,
  initialEnabled,
  initialRoots,
  initialPlans,
  onComplete
}: Readonly<OnboardingProps>) {
  const [step, setStep] = useState<"providers" | "repos" | "plans" | "phone">("providers");
  const [enabled, setEnabled] = useState<AgentBackend[]>(initialEnabled);
  const [roots, setRoots] = useState<string[]>(initialRoots);
  const [plans, setPlans] = useState<Plans>(initialPlans);

  if (step === "providers") {
    return (
      <ProviderOnboarding
        catalog={catalog}
        detecting={detecting}
        initialEnabled={enabled}
        onContinue={(chosen) => {
          setEnabled(chosen);
          setStep("repos");
        }}
      />
    );
  }

  if (step === "repos") {
    return (
      <RepoLocationsStep
        client={client}
        initialRoots={roots}
        onBack={() => setStep("providers")}
        onFinish={(chosenRoots) => {
          setRoots(chosenRoots);
          setStep("plans");
        }}
      />
    );
  }

  if (step === "plans") {
    return (
      <main className="onboarding">
        <div className="onboarding-card wide">
          <span className="brand-mark onboarding-mark" aria-hidden="true">
            <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
          </span>
          <p className="eyebrow">Step 3 of 4</p>
          <h1 className="onboarding-title">How do you pay for your providers?</h1>
          <p className="onboarding-sub">
            If you pay a flat monthly fee for a provider, extra requests are effectively
            free until you hit its cap, so "Optimize cost" can prefer it. Optional: you
            can set this later in Settings.
          </p>
          <PlansSettings plans={plans} onChange={setPlans} heading="Your subscription plans" />
          <div className="onboarding-actions spread">
            <button type="button" className="onboarding-back" onClick={() => setStep("repos")}>
              Back
            </button>
            <button
              type="button"
              className="onboarding-continue"
              onClick={() => setStep("phone")}
            >
              Continue
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="onboarding">
      <div className="onboarding-card wide">
        <span className="brand-mark onboarding-mark" aria-hidden="true">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
        </span>
        <p className="eyebrow">Step 4 of 4</p>
        <h1 className="onboarding-title">Connect a phone (optional)</h1>
        <p className="onboarding-sub">
          HoneyHub runs on this computer. To open it on your phone too, pair it now, or skip
          and do it any time from Settings.
        </p>
        <ConnectPhone client={client} active />
        <div className="onboarding-actions spread">
          <button type="button" className="onboarding-back" onClick={() => setStep("plans")}>
            Back
          </button>
          <button
            type="button"
            className="onboarding-continue"
            onClick={() => onComplete(enabled, roots, plans)}
          >
            Enter the cockpit
          </button>
        </div>
      </div>
    </main>
  );
}
