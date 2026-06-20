import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";

// First-run provider selection (packet 09 §3 onboarding). The bridge detects which
// CLIs are installed; this screen lets the user confirm which to enable. Detected
// providers are pre-checked; the choice persists and is editable later in Bridge
// settings. The same selection model backs both surfaces.

export interface ProviderOnboardingProps {
  /** The detected backends (from the bridge). Empty while detection is in flight. */
  catalog: BackendCapability[];
  /** True until the first backend catalog arrives. */
  detecting: boolean;
  /** A prior selection to seed from (e.g. re-running onboarding). */
  initialEnabled: AgentBackend[];
  /** Advance to the next onboarding step with the chosen providers. */
  onContinue: (enabled: AgentBackend[]) => void;
}

export function ProviderOnboarding({
  catalog,
  detecting,
  initialEnabled,
  onContinue
}: Readonly<ProviderOnboardingProps>) {
  const [selected, setSelected] = useState<Set<AgentBackend>>(
    () => new Set(initialEnabled)
  );
  // Keep the default selection (the detected providers) in sync with the catalog
  // until the user touches a checkbox. The catalog can arrive in stages (a mock
  // catalog before the real bridge answers), so re-seeding on each update means the
  // final, real detection drives the defaults — while an explicit toggle (or a prior
  // saved selection) freezes the choice so it is never clobbered.
  const userTouched = useRef(initialEnabled.length > 0);
  useEffect(() => {
    if (userTouched.current || catalog.length === 0) {
      return;
    }
    setSelected(
      new Set(catalog.filter((entry) => entry.available).map((entry) => entry.backend))
    );
  }, [catalog]);

  const toggle = (backend: AgentBackend) => {
    userTouched.current = true;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(backend)) {
        next.delete(backend);
      } else {
        next.add(backend);
      }
      return next;
    });
  };

  const detectedCount = useMemo(
    () => catalog.filter((entry) => entry.available).length,
    [catalog]
  );

  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <span className="brand-mark onboarding-mark" aria-hidden="true">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
        </span>
        <p className="eyebrow">Welcome to HoneyHub</p>
        <h1 className="onboarding-title">Which agents do you have?</h1>
        <p className="onboarding-sub">
          HoneyHub drives the official CLIs you already use, under your own local
          session. Pick the ones you have installed; you can change this anytime in
          Settings.
        </p>

        {detecting ? (
          <p className="onboarding-detecting">Detecting installed providers…</p>
        ) : (
          <p className="onboarding-detecting">
            {detectedCount > 0
              ? `Detected ${detectedCount} installed on this machine.`
              : "None detected on this machine. Enable any you plan to install."}
          </p>
        )}

        <ul className="provider-list" aria-label="Providers">
          {catalog.map((entry) => (
            <li key={entry.backend}>
              <label className="provider-row">
                <input
                  type="checkbox"
                  checked={selected.has(entry.backend)}
                  onChange={() => toggle(entry.backend)}
                />
                <span className="provider-main">
                  <span className="provider-name">{backendLabel(entry.backend)}</span>
                  <span className="provider-meta">
                    <code>{entry.program}</code>
                    {" · "}
                    {entry.models.length} model{entry.models.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span
                  className={`provider-chip ${entry.available ? "is-detected" : "is-missing"}`}
                >
                  {entry.available ? "Detected" : "Not found"}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-continue"
            disabled={detecting}
            onClick={() => onContinue([...selected])}
          >
            {selected.size > 0 ? "Continue" : "Skip for now"}
          </button>
        </div>
      </div>
    </main>
  );
}
