import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { AgentBackend, BackendCapability, EnvironmentInfo } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { backendLabel } from "../../backends";
import { APP_VERSION, isTauriShell } from "../../appVersion";
import { diffNewModels, mergeSeen, newModelCount, type SeenModels } from "./updatesModel";
import { loadSeenModels, saveSeenModels } from "./modelsSeenStore";

export interface UpdatesViewProps {
  client: WireClient;
  active: boolean;
  /** The detected backend catalog (CLIs + models), owned by App. */
  catalog: BackendCapability[];
}

/**
 * Updates (control-hub roadmap #8): installed CLI versions + new-model awareness. Versions
 * come from the bridge running `<cli> --version` (installed-only — no registry "latest"
 * lookup, so it never claims an update is available). New models are a client-side diff of
 * the detected catalog against the set last seen on this device; the Codex model cache is
 * maintained by the Codex CLI, so "refresh" re-reads it rather than forcing a repopulate.
 */
export function UpdatesView({ client, active, catalog }: Readonly<UpdatesViewProps>): ReactElement {
  const [environment, setEnvironment] = useState<EnvironmentInfo | undefined>(undefined);
  const [seen, setSeen] = useState<SeenModels>(loadSeenModels);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    void client.detectEnvironment().catch(() => setLoading(false));
    // Re-read the model caches too (App listens for backend_catalog into `catalog`).
    void client.discoverBackends().catch(() => undefined);
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "environment_info") {
        setEnvironment(event.payload.environment);
        setLoading(false);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh]);

  const newModels = useMemo(() => diffNewModels(catalog, seen), [catalog, seen]);
  const newCount = newModelCount(newModels);

  // Baseline silently on first sight (no badges on first run): when a backend has no record
  // yet but the catalog has it, record it. Only auto-baselines; never clears real "new"s.
  useEffect(() => {
    if (catalog.length === 0) {
      return;
    }
    const anyUnseen = catalog.some((entry) => seen[entry.backend] === undefined);
    if (anyUnseen) {
      const next = mergeSeen(
        catalog.filter((entry) => seen[entry.backend] === undefined),
        seen
      );
      setSeen(next);
      saveSeenModels(next);
    }
  }, [catalog, seen]);

  const acknowledge = () => {
    const next = mergeSeen(catalog, seen);
    setSeen(next);
    saveSeenModels(next);
  };

  const versionFor = (backend: AgentBackend): string => {
    const entry = environment?.backends.find((item) => item.backend === backend);
    if (entry === undefined) {
      return "-";
    }
    if (!entry.available) {
      return "not installed";
    }
    return entry.version ?? "installed";
  };

  return (
    <section className="updates" aria-label="Updates">
      <header className="updates-header">
        <h2>Updates</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "Checking…" : "Check now"}
        </button>
      </header>
      <p className="updates-scope">
        The app itself, your installed CLI versions, and newly-available models. Versions are
        read from your local CLIs; new models are detected by comparing what each CLI offers now
        against what you last saw here.
      </p>

      <div className="updates-card updates-app-card">
        <div className="updates-card-head">
          <span className="updates-name">HoneyHub app</span>
          <span className="updates-version">v{APP_VERSION}</span>
        </div>
        <p className="updates-source">
          {isTauriShell()
            ? "Desktop app: it checks for updates on launch and installs them with your OK."
            : "Web app: reload to get the latest. Install the desktop app for automatic updates."}
        </p>
      </div>

      {newCount > 0 && (
        <output className="updates-banner">
          <span>
            {newCount} new model{newCount === 1 ? "" : "s"} available.
          </span>
          <button type="button" onClick={acknowledge}>
            Mark all as seen
          </button>
        </output>
      )}

      <ul className="updates-list">
        {catalog.map((entry) => {
          const fresh = newModels[entry.backend] ?? [];
          return (
            <li key={entry.backend} className="updates-card">
              <div className="updates-card-head">
                <span className="updates-name">{backendLabel(entry.backend)}</span>
                <span className="updates-version">{versionFor(entry.backend)}</span>
              </div>
              <div className="updates-models">
                {entry.models.length === 0 ? (
                  <span className="updates-empty">No models detected.</span>
                ) : (
                  entry.models.map((model) => (
                    <span
                      key={model.id}
                      className={`updates-model ${fresh.includes(model.id) ? "is-new" : ""}`}
                    >
                      {model.label}
                      {fresh.includes(model.id) && <span className="updates-new">NEW</span>}
                    </span>
                  ))
                )}
              </div>
              <p className="updates-source">source: {entry.modelSource.replace("_", " ")}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
