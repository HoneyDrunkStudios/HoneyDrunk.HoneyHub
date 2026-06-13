import type {
  AgentBackend,
  PairedDeviceView,
  PairingGrant
} from "@honeydrunk/honeyhub-types";

// Client-side model for the bridge-settings surface (ADR-0090 D8). It holds the
// user's pairing + allowlist intent before it is sent to the local bridge over
// the wire protocol (packet 04). The transport lands with the relay work; this
// keeps the trust-config logic pure and testable in the meantime.

export const allBackends: AgentBackend[] = [
  "claude.local",
  "codex.local",
  "copilot.local"
];

export interface BridgeSettingsState {
  devices: PairedDeviceView[];
  workspaceRoots: string[];
  backends: AgentBackend[];
  // The most recent pairing token, surfaced exactly once for the user to copy to
  // the client device. It is cleared as soon as it is acknowledged.
  lastGrant?: PairingGrant;
}

export const emptyBridgeSettings: BridgeSettingsState = {
  devices: [],
  workspaceRoots: [],
  backends: []
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
  token: () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll(/-/g, ""),
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
  return {
    ...state,
    workspaceRoots: state.workspaceRoots.filter((existing) => existing !== root)
  };
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
