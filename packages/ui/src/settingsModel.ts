import type {
  AgentBackend,
  PairedDeviceView,
  PairingGrant
} from "@honeydrunk/honeyhub-types";

// Client-side model for the bridge-settings surface (ADR-0090 D8). It holds the
// user's pairing + allowlist intent before it is sent to the local bridge over
// the wire protocol (packet 04). The transport lands with the relay work; this
// keeps the trust-config logic pure and testable in the meantime.

// Surfaced backends. Copilot is intentionally excluded (it exposes no enumerable
// model list and reaching its model API would require holding vendor auth); the type
// still includes it for the backend abstraction, it is just not offered.
export const allBackends: AgentBackend[] = ["claude.local", "codex.local"];

/** Per-provider enabled model ids. A backend absent from the map means **all** its
    models are enabled (the default) — so a fresh cockpit restricts nothing. */
export type EnabledModels = Partial<Record<AgentBackend, string[]>>;

export interface BridgeSettingsState {
  devices: PairedDeviceView[];
  workspaceRoots: string[];
  /** The default workspace, pre-selected across Chat / Git / Browse. Changeable any time.
      Absent (or no longer a configured root) = fall back to the first root. */
  defaultWorkspaceRoot?: string;
  backends: AgentBackend[];
  // Which models are enabled per provider (Bridge settings, not onboarding). Absent
  // entry = all models on. Both the manual model picker and the optimize-mode auto
  // choice are restricted to these.
  enabledModels: EnabledModels;
  // The most recent pairing token, surfaced exactly once for the user to copy to
  // the client device. It is cleared as soon as it is acknowledged.
  lastGrant?: PairingGrant;
}

export const emptyBridgeSettings: BridgeSettingsState = {
  devices: [],
  workspaceRoots: [],
  backends: [],
  enabledModels: {}
};

// Seams for id/token/timestamp generation so the reducer stays deterministic
// under test. The bridge is the real source of these in production; the UI only
// mirrors them until the transport exists.
export interface PairingFactory {
  deviceId(): string;
  token(): string;
  now(): string;
}

export const defaultPairingFactory: PairingFactory = {
  deviceId: () => crypto.randomUUID(),
  token: () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
  now: () => new Date().toISOString()
};

export function isAbsoluteWorkspaceRoot(path: string): boolean {
  if (path.startsWith("/")) return true; // POSIX
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // Windows drive
  if (path.startsWith("\\\\")) return true; // Windows UNC
  return false;
}

export function pairDevice(
  state: BridgeSettingsState,
  displayName: string,
  factory: PairingFactory = defaultPairingFactory
): BridgeSettingsState {
  const name = displayName.trim();
  if (name.length === 0) {
    throw new Error("device name is required");
  }
  const grant: PairingGrant = {
    device: {
      deviceId: factory.deviceId(),
      displayName: name,
      pairedAt: factory.now(),
      revoked: false
    },
    token: factory.token()
  };
  return {
    ...state,
    devices: [...state.devices, grant.device],
    lastGrant: grant
  };
}

export function acknowledgeGrant(state: BridgeSettingsState): BridgeSettingsState {
  if (state.lastGrant === undefined) return state;
  const { lastGrant: _lastGrant, ...rest } = state;
  return rest;
}

export function revokeDevice(
  state: BridgeSettingsState,
  deviceId: string
): BridgeSettingsState {
  if (!state.devices.some((device) => device.deviceId === deviceId)) {
    throw new Error("device is not paired");
  }
  return {
    ...state,
    devices: state.devices.map((device) =>
      device.deviceId === deviceId ? { ...device, revoked: true } : device
    )
  };
}

export function addWorkspaceRoot(
  state: BridgeSettingsState,
  root: string
): BridgeSettingsState {
  const trimmed = root.trim();
  if (!isAbsoluteWorkspaceRoot(trimmed)) {
    throw new Error("workspace root must be an absolute path");
  }
  if (state.workspaceRoots.includes(trimmed)) {
    throw new Error("workspace root is already on the allowlist");
  }
  return { ...state, workspaceRoots: [...state.workspaceRoots, trimmed] };
}

export function removeWorkspaceRoot(
  state: BridgeSettingsState,
  root: string
): BridgeSettingsState {
  if (!state.workspaceRoots.includes(root)) {
    throw new Error("workspace root is not on the allowlist");
  }
  const next: BridgeSettingsState = {
    ...state,
    workspaceRoots: state.workspaceRoots.filter((existing) => existing !== root)
  };
  // Dropping the default root clears the default (consumers fall back to the first root).
  if (next.defaultWorkspaceRoot === root) {
    delete next.defaultWorkspaceRoot;
  }
  return next;
}

/** Set (or clear, with `undefined`) the default workspace. Setting requires the root to be
    on the allowlist, so the default never points at a location that is not configured. */
export function setDefaultWorkspaceRoot(
  state: BridgeSettingsState,
  root: string | undefined
): BridgeSettingsState {
  if (root === undefined) {
    if (state.defaultWorkspaceRoot === undefined) {
      return state;
    }
    const next = { ...state };
    delete next.defaultWorkspaceRoot;
    return next;
  }
  if (!state.workspaceRoots.includes(root)) {
    throw new Error("default workspace must be a configured root");
  }
  return { ...state, defaultWorkspaceRoot: root };
}

/** The effective default workspace for a consumer: the configured default when it is still
    a valid root, else the first root, else "" (no workspace). Centralizes the fallback so
    Chat / Git / Browse all agree on which location is pre-selected. */
export function resolveDefaultWorkspaceRoot(
  roots: string[],
  defaultRoot: string | undefined
): string {
  if (defaultRoot !== undefined && roots.includes(defaultRoot)) {
    return defaultRoot;
  }
  return roots[0] ?? "";
}

export function setBackendAllowed(
  state: BridgeSettingsState,
  backend: AgentBackend,
  allowed: boolean
): BridgeSettingsState {
  const has = state.backends.includes(backend);
  if (allowed && !has) {
    return { ...state, backends: [...state.backends, backend] };
  }
  if (!allowed && has) {
    return {
      ...state,
      backends: state.backends.filter((existing) => existing !== backend)
    };
  }
  return state;
}

/** Whether a specific model is enabled for a backend. An absent map entry means all
    models for that backend are enabled (the default). */
export function isModelEnabled(
  state: BridgeSettingsState,
  backend: AgentBackend,
  modelId: string
): boolean {
  const enabled = state.enabledModels[backend];
  return enabled === undefined || enabled.includes(modelId);
}

/**
 * Enable/disable one model for a backend. `allModelIds` is the backend's full model
 * set (from detection), used to normalize "all enabled" back to an absent entry so
 * the default stays "everything on". The last enabled model can never be turned off
 * (the auto/optimize path must always have at least one model to choose).
 */
export function setModelAllowed(
  state: BridgeSettingsState,
  backend: AgentBackend,
  modelId: string,
  allowed: boolean,
  allModelIds: string[]
): BridgeSettingsState {
  const current = state.enabledModels[backend] ?? [...allModelIds];
  let next: string[];
  if (allowed) {
    next = current.includes(modelId) ? current : [...current, modelId];
  } else {
    next = current.filter((id) => id !== modelId);
    if (next.length === 0) {
      // Refuse to disable the last model — there must always be one to run.
      return state;
    }
  }
  const map: EnabledModels = { ...state.enabledModels };
  const coversAll =
    allModelIds.length > 0 && allModelIds.every((id) => next.includes(id));
  if (coversAll) {
    // Back to the default (everything on) — drop the entry so it reads as unrestricted.
    delete map[backend];
  } else {
    map[backend] = next;
  }
  return { ...state, enabledModels: map };
}
