import { useState } from "react";
import type { ReactElement } from "react";
import type { WireClient } from "../../wire/client";
import {
  getConnectorConfig,
  isConnectorEnabled,
  KNOWN_CONNECTORS,
  loadConnectorConfig,
  loadConnectorPrefs,
  saveConnectorConfig,
  saveConnectorPrefs,
  setConnectorConfig,
  setConnectorEnabled,
  type ConnectorCategory,
  type ConnectorConfig,
  type ConnectorDef,
  type ConnectorPrefs
} from "../../connectors";

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  work: "Work",
  observability: "Observability"
};

export interface ConnectorsSettingsProps {
  /** The transport, so configured connectors (Grafana/Sentry) can be test-fired in place. */
  client?: WireClient;
}

/**
 * Connectors (opt-in integrations) settings. Nothing is on by default; flip a connector on to
 * make it appear in the hub. Connectors not built yet are listed (as the roadmap) but their
 * toggle is disabled and tagged "Coming soon" — the settings never claim a feature that isn't
 * wired. Prefs persist locally; the Work/observability surfaces re-read them on activation.
 */
export function ConnectorsSettings({ client }: Readonly<ConnectorsSettingsProps>): ReactElement {
  const [prefs, setPrefs] = useState<ConnectorPrefs>(() => loadConnectorPrefs());
  const [config, setConfig] = useState<ConnectorConfig>(() => loadConnectorConfig());

  const toggle = (id: string, on: boolean): void => {
    const next = setConnectorEnabled(prefs, id, on);
    setPrefs(next);
    saveConnectorPrefs(next);
  };

  const saveConfig = (id: string, values: Record<string, string>): void => {
    const next = setConnectorConfig(config, id, values);
    setConfig(next);
    saveConnectorConfig(next);
  };

  const categories: ConnectorCategory[] = ["work", "observability"];

  return (
    <fieldset className="connectors">
      <legend>Connectors</legend>
      <p className="connectors-intro">
        Opt-in, read-only integrations. Turn one on and it shows up in the hub — nothing is
        connected until you choose to.
      </p>
      {categories.map((category) => (
        <div key={category} className="connectors-group">
          <p className="connectors-group-title">{CATEGORY_LABEL[category]}</p>
          <ul className="connectors-list">
            {KNOWN_CONNECTORS.filter((connector) => connector.category === category).map(
              (connector) => {
                const available = connector.status === "available";
                return (
                  <li key={connector.id} className={`connector ${available ? "" : "is-planned"}`}>
                    <label className="connector-toggle">
                      <input
                        type="checkbox"
                        checked={isConnectorEnabled(prefs, connector.id)}
                        disabled={!available}
                        onChange={(event) => toggle(connector.id, event.target.checked)}
                      />
                      <span className="connector-name">{connector.label}</span>
                      {!available && <span className="connector-soon">Coming soon</span>}
                    </label>
                    <p className="connector-desc">{connector.description}</p>
                    <p className="connector-auth">{connector.authNote}</p>
                    {available && (connector.configFields?.length ?? 0) > 0 && (
                      <ConnectorConfigForm
                        connector={connector}
                        values={getConnectorConfig(config, connector.id)}
                        onSave={(values) => saveConfig(connector.id, values)}
                        {...(client !== undefined ? { client } : {})}
                      />
                    )}
                  </li>
                );
              }
            )}
          </ul>
        </div>
      ))}
    </fieldset>
  );
}

interface ConnectorConfigFormProps {
  connector: ConnectorDef;
  values: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  client?: WireClient;
}

interface TestResult {
  ok: boolean;
  message: string;
}

/** A small per-connector config form (e.g. Grafana base URL + token). Secret fields are
    masked. Saves the whole field set at once; values are stored locally only. A "Test"
    affordance fires the connector's read-only summary with the *draft* values and reports
    ok/error inline, so config can be validated without leaving Settings. */
function ConnectorConfigForm({
  connector,
  values,
  onSave,
  client
}: Readonly<ConnectorConfigFormProps>): ReactElement {
  const [draft, setDraft] = useState<Record<string, string>>(values);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | undefined>(undefined);
  const fields = connector.configFields ?? [];
  const canTest = client !== undefined && (connector.id === "grafana" || connector.id === "sentry");

  const runTest = (): void => {
    if (client === undefined) {
      return;
    }
    setTesting(true);
    setResult(undefined);
    // Listen for this connector's summary event, then fire the read-only fetch with the draft.
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (connector.id === "grafana" && payload.kind === "grafana_summary") {
        unsubscribe();
        setTesting(false);
        setResult(
          payload.summary.available
            ? { ok: true, message: `Connected · v${payload.summary.version ?? "?"}` }
            : { ok: false, message: payload.summary.error ?? "could not connect" }
        );
      } else if (connector.id === "sentry" && payload.kind === "sentry_summary") {
        unsubscribe();
        setTesting(false);
        setResult(
          payload.summary.available
            ? { ok: true, message: `Connected · ${payload.summary.issues.length} unresolved` }
            : { ok: false, message: payload.summary.error ?? "could not connect" }
        );
      }
    });
    const fail = (): void => {
      unsubscribe();
      setTesting(false);
      setResult({ ok: false, message: "could not connect" });
    };
    if (connector.id === "grafana") {
      client.grafanaSummary(draft.baseUrl ?? "", draft.token ?? "").catch(fail);
    } else if (connector.id === "sentry") {
      client
        .sentrySummary({
          baseUrl: draft.baseUrl ?? "",
          org: draft.org ?? "",
          project: draft.project ?? "",
          token: draft.token ?? ""
        })
        .catch(fail);
    }
  };

  return (
    <div className="connector-config">
      {fields.map((field) => (
        <label key={field.key} className="connector-config-field">
          <span>{field.label}</span>
          <input
            type={field.secret ? "password" : "text"}
            value={draft[field.key] ?? ""}
            placeholder={field.placeholder ?? ""}
            onChange={(event) => {
              setDraft((prev) => ({ ...prev, [field.key]: event.target.value }));
              setSaved(false);
              setResult(undefined);
            }}
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() => {
          onSave(draft);
          setSaved(true);
        }}
      >
        {saved ? "Saved" : "Save"}
      </button>
      {canTest && (
        <button type="button" className="connector-test" onClick={runTest} disabled={testing}>
          {testing ? "Testing…" : "Test"}
        </button>
      )}
      {result !== undefined && (
        <span
          role="status"
          className={`connector-test-result ${result.ok ? "is-ok" : "is-error"}`}
        >
          {result.ok ? "✓" : "✗"} {result.message}
        </span>
      )}
    </div>
  );
}
