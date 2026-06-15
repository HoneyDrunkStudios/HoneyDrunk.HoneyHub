// Connectors framework (opt-in, read-only): the registry of external integrations the cockpit
// can pull from, plus a thin localStorage seam for which ones the user has enabled. NOTHING is
// enabled by default — the hub stays clean until you opt in. Each connector declares whether
// it's wired up yet (`status`), so the settings UI can show a roadmap honestly without faking
// features. Pure helpers, kept out of components so they're unit-testable.

export type ConnectorCategory = "work" | "observability";

/** `available` = wired and usable now; `planned` = listed but not built yet (toggle disabled). */
export type ConnectorStatus = "available" | "planned";

/** A config field a connector needs (e.g. Grafana base URL / API token). `secret` masks the
    input and keeps the value out of display. Stored locally, never on the host. */
export interface ConnectorConfigField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  /** Optional fields don't gate `isConnectorConfigured` (e.g. anonymous Grafana token). */
  optional?: boolean;
}

export interface ConnectorDef {
  id: string;
  label: string;
  category: ConnectorCategory;
  status: ConnectorStatus;
  /** One-line description shown in settings. */
  description: string;
  /** How auth is handled, shown so the user knows no secret is stored when true. */
  authNote: string;
  /** Config inputs this connector needs before it can be used (e.g. URL + token). */
  configFields?: ConnectorConfigField[];
}

/** The known connectors. Only GitHub is wired in v1; the rest are the published roadmap. */
export const KNOWN_CONNECTORS: ConnectorDef[] = [
  {
    id: "github",
    label: "GitHub",
    category: "work",
    status: "available",
    description: "Issues assigned to you, PRs you authored, and PRs that request your review.",
    authNote: "Uses your existing GitHub CLI sign-in (gh) — no token stored."
  },
  {
    id: "ado",
    label: "Azure DevOps",
    category: "work",
    status: "available",
    description: "Work items assigned to you across your projects.",
    authNote: "Uses your Azure CLI sign-in (az) — no token stored."
  },
  {
    id: "servicebus",
    label: "Azure Service Bus",
    category: "observability",
    status: "available",
    description: "Queues, topics, subscriptions, and dead-letter counts.",
    authNote: "Uses your Azure CLI sign-in (az) — no connection string stored."
  },
  {
    id: "grafana",
    label: "Grafana (traces / metrics / logs)",
    category: "observability",
    status: "available",
    description: "Pulse telemetry — Tempo traces, Mimir metrics, Loki logs.",
    authNote: "Point it at your Grafana base URL + an API token (stored locally only).",
    configFields: [
      { key: "baseUrl", label: "Base URL", placeholder: "https://grafana.example.com" },
      { key: "token", label: "API token", placeholder: "glsa_…", secret: true, optional: true }
    ]
  },
  {
    id: "sentry",
    label: "Sentry (errors)",
    category: "observability",
    status: "available",
    description: "Unresolved error events grouped by issue.",
    authNote: "Point it at your Sentry org/project + an API token (stored locally only).",
    configFields: [
      { key: "org", label: "Org slug", placeholder: "honeydrunk" },
      { key: "project", label: "Project slug", placeholder: "honeyhub" },
      { key: "token", label: "API token", placeholder: "sntrys_…", secret: true },
      { key: "baseUrl", label: "Base URL", placeholder: "https://sentry.io", optional: true }
    ]
  }
];

const STORAGE_KEY = "honeyhub.connectors.v1";

/** id → enabled. Absent id = not enabled (the default for everything). */
export type ConnectorPrefs = Record<string, boolean>;

export function isConnectorEnabled(prefs: ConnectorPrefs, id: string): boolean {
  return prefs[id] === true;
}

/** Toggle a connector. A `planned` connector can never be enabled (guarded here too, not just
    in the UI), so persisted prefs can't claim a feature that isn't built. */
export function setConnectorEnabled(prefs: ConnectorPrefs, id: string, on: boolean): ConnectorPrefs {
  const def = KNOWN_CONNECTORS.find((connector) => connector.id === id);
  if (def === undefined || def.status !== "available") {
    return prefs;
  }
  return { ...prefs, [id]: on };
}

/** The enabled connector ids in a category (e.g. the work sources to query). */
export function enabledIds(prefs: ConnectorPrefs, category: ConnectorCategory): string[] {
  return KNOWN_CONNECTORS.filter(
    (connector) => connector.category === category && isConnectorEnabled(prefs, connector.id)
  ).map((connector) => connector.id);
}

export function loadConnectorPrefs(): ConnectorPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const out: ConnectorPrefs = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) {
        out[id] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveConnectorPrefs(prefs: ConnectorPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — keep the in-memory prefs for this session only.
  }
}

const CONFIG_KEY = "honeyhub.connectorConfig.v1";

/** Per-connector config values: connectorId → (fieldKey → value). Stored locally only —
    secrets (API tokens) never leave the device except to the local bridge on demand. */
export type ConnectorConfig = Record<string, Record<string, string>>;

export function getConnectorConfig(config: ConnectorConfig, id: string): Record<string, string> {
  return config[id] ?? {};
}

/** A connector is "configured" when every declared config field has a non-empty value. */
export function isConnectorConfigured(config: ConnectorConfig, id: string): boolean {
  const def = KNOWN_CONNECTORS.find((connector) => connector.id === id);
  const fields = def?.configFields ?? [];
  if (fields.length === 0) {
    return true; // no config required (e.g. github/ado use the CLI sign-in)
  }
  const values = getConnectorConfig(config, id);
  return fields
    .filter((field) => !field.optional)
    .every((field) => (values[field.key] ?? "").trim().length > 0);
}

export function setConnectorConfig(
  config: ConnectorConfig,
  id: string,
  values: Record<string, string>
): ConnectorConfig {
  return { ...config, [id]: values };
}

export function loadConnectorConfig(): ConnectorConfig {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const out: ConnectorConfig = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        const fields: Record<string, string> = {};
        for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
          if (typeof fieldValue === "string") {
            fields[key] = fieldValue;
          }
        }
        out[id] = fields;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveConnectorConfig(config: ConnectorConfig): void {
  try {
    globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable — keep the in-memory config for this session only.
  }
}
