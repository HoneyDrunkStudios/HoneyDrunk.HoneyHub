import { useState } from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { ConnectPhone } from "../settings/ConnectPhone";
import { ProviderOnboarding } from "./ProviderOnboarding";
import { RepoLocationsStep } from "./RepoLocationsStep";

export interface OnboardingProps {
  client: WireClient;
  catalog: BackendCapability[];
  detecting: boolean;
  initialEnabled: AgentBackend[];
  initialRoots: string[];
  /** Commit the chosen providers + repo locations and enter the cockpit. */
  onComplete: (enabled: AgentBackend[], roots: string[]) => void;
}

/** First-run flow: pick providers (1), where your repos live (2), then optionally connect a
    phone (3). The phone step is skippable — it's a convenience, not a requirement. */
export function Onboarding({
  client,
  catalog,
  detecting,
  initialEnabled,
  initialRoots,
  onComplete
}: Readonly<OnboardingProps>) {
  const [step, setStep] = useState<"providers" | "repos" | "phone">("providers");
  const [enabled, setEnabled] = useState<AgentBackend[]>(initialEnabled);
  const [roots, setRoots] = useState<string[]>(initialRoots);

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
          setStep("phone");
        }}
      />
    );
  }

  return (
    <main className="onboarding">
      <div className="onboarding-card wide">
        <span className="brand-mark onboarding-mark" aria-hidden="true">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
        </span>
        <p className="eyebrow">Step 3 of 3</p>
        <h1 className="onboarding-title">Connect a phone (optional)</h1>
        <p className="onboarding-sub">
          HoneyHub runs on this computer. To open it on your phone too, pair it now — or skip
          and do it any time from Settings.
        </p>
        <ConnectPhone client={client} active />
        <div className="onboarding-actions spread">
          <button type="button" className="onboarding-back" onClick={() => setStep("repos")}>
            Back
          </button>
          <button
            type="button"
            className="onboarding-continue"
            onClick={() => onComplete(enabled, roots)}
          >
            Enter the cockpit
          </button>
        </div>
      </div>
    </main>
  );
}
