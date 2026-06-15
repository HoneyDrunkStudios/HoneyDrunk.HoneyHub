import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { allBackends, type EnabledModels } from "./settingsModel";

// Persisted provider preferences (packet 09 §3 onboarding). The first launch shows
// a provider-selection screen; the user's choice (and that they've completed it) is
// stored locally so it does not reappear every launch, and the same set is editable
// later in Bridge settings. Local-only, no secrets — just which backends are enabled.

const STORAGE_KEY = "honeyhub.providerPrefs.v1";

export interface ProviderPrefs {
  /** Whether the first-run provider-selection screen has been completed. */
  onboarded: boolean;
  /** The backends the user enabled. Drives the run-screen pickers + the router. */
  enabled: AgentBackend[];
  /** Per-provider enabled model ids (Bridge settings). Absent backend = all on. */
  enabledModels: EnabledModels;
  /** Repo locations the user picked — the bridge's workspace roots + Browse starting
      points. */
  workspaceRoots: string[];
}

export const emptyProviderPrefs: ProviderPrefs = {
  onboarded: false,
  enabled: [],
  enabledModels: {},
  workspaceRoots: []
};

function isAgentBackend(value: unknown): value is AgentBackend {
  return typeof value === "string" && (allBackends as string[]).includes(value);
}

/** Load saved preferences, tolerating missing/corrupt/legacy storage by falling
    back to the not-yet-onboarded empty state. Never throws. */
export function loadProviderPrefs(): ProviderPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return emptyProviderPrefs;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return emptyProviderPrefs;
    }
    const record = parsed as Record<string, unknown>;
    const enabled = Array.isArray(record.enabled)
      ? record.enabled.filter(isAgentBackend)
      : [];
    const roots = Array.isArray(record.workspaceRoots)
      ? record.workspaceRoots.filter((root): root is string => typeof root === "string")
      : [];
    return {
      onboarded: record.onboarded === true,
      // De-dupe defensively so a corrupt store can't seed duplicate toggles.
      enabled: [...new Set(enabled)],
      enabledModels: parseEnabledModels(record.enabledModels),
      workspaceRoots: [...new Set(roots)]
    };
  } catch {
    return emptyProviderPrefs;
  }
}

/** Parse a persisted per-provider model map, keeping only known backends and string
    model ids. Anything malformed collapses to the unrestricted default ({}). */
function parseEnabledModels(value: unknown): EnabledModels {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: EnabledModels = {};
  for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
    if (isAgentBackend(key) && Array.isArray(ids)) {
      const models = ids.filter((id): id is string => typeof id === "string");
      if (models.length > 0) {
        result[key] = [...new Set(models)];
      }
    }
  }
  return result;
}

/** Persist preferences. Never throws (storage may be unavailable/full). */
export function saveProviderPrefs(prefs: ProviderPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort: a cockpit that can't persist still works for the session.
  }
}
