import { useState } from "react";
import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import {
  acknowledgeGrant,
  addWorkspaceRoot,
  allBackends,
  emptyBridgeSettings,
  pairDevice,
  removeWorkspaceRoot,
  revokeDevice,
  setBackendAllowed,
  type BridgeSettingsState,
  type PairingFactory
} from "./settingsModel";

export interface BridgeSettingsProps {
  initialState?: BridgeSettingsState;
  factory?: PairingFactory;
  // Optional controlled state: when `state` + `onChange` are supplied the parent
  // owns the settings (so the run screen can read the workspace allowlist);
  // otherwise the component manages its own state.
  state?: BridgeSettingsState;
  onChange?: (next: BridgeSettingsState) => void;
}

export function BridgeSettings({
  initialState,
  factory,
  state: controlledState,
  onChange
}: Readonly<BridgeSettingsProps>) {
  const [internalState, setInternalState] = useState<BridgeSettingsState>(
    initialState ?? emptyBridgeSettings
  );
  const state = controlledState ?? internalState;
  const setState: (next: BridgeSettingsState) => void = onChange ?? setInternalState;
  const [deviceName, setDeviceName] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  // Compute the next state exactly once (model transitions can consume a
  // PairingFactory id/token, so a second evaluation would waste one) and commit
  // it. Each handler is a discrete user event, so `state` is the latest committed
  // value here — there is no batched multi-update in a single tick to go stale
  // against. Returns whether the transition succeeded so callers clear inputs
  // only on success.
  const apply = (
    compute: (prev: BridgeSettingsState) => BridgeSettingsState
  ): boolean => {
    try {
      const next = compute(state);
      setState(next);
      setError(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "unexpected error");
      return false;
    }
  };

  const onPair = () => {
    if (apply((prev) => pairDevice(prev, deviceName, factory))) {
      setDeviceName("");
    }
  };

  const onAddRoot = () => {
    if (apply((prev) => addWorkspaceRoot(prev, workspaceRoot))) {
      setWorkspaceRoot("");
    }
  };

  return (
    <section className="bridge-settings" aria-label="Bridge settings">
      <h2>Bridge settings</h2>

      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}

      <fieldset>
        <legend>Pair a device</legend>
        <label htmlFor="device-name">Device name</label>
        <input
          id="device-name"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
        />
        <button type="button" onClick={onPair}>
          Pair device
        </button>

        {state.lastGrant !== undefined && (
          <output className="pairing-token">
            <p>
              Copy this token to <strong>{state.lastGrant.device.displayName}</strong>{" "}
              now. It is shown only once.
            </p>
            <code>{state.lastGrant.token}</code>
            <button type="button" onClick={() => setState(acknowledgeGrant(state))}>
              Done
            </button>
          </output>
        )}

        <ul aria-label="Paired devices">
          {state.devices.map((device) => (
            <li key={device.deviceId}>
              <span>{device.displayName}</span>
              <span className="device-state">
                {device.revoked ? "revoked" : "active"}
              </span>
              {!device.revoked && (
                <button
                  type="button"
                  onClick={() => apply((prev) => revokeDevice(prev, device.deviceId))}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Workspace roots</legend>
        <label htmlFor="workspace-root">Absolute path</label>
        <input
          id="workspace-root"
          value={workspaceRoot}
          onChange={(event) => setWorkspaceRoot(event.target.value)}
        />
        <button type="button" onClick={onAddRoot}>
          Add root
        </button>
        <ul aria-label="Workspace roots">
          {state.workspaceRoots.map((root) => (
            <li key={root}>
              <code>{root}</code>
              <button
                type="button"
                onClick={() => apply((prev) => removeWorkspaceRoot(prev, root))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Backends</legend>
        {allBackends.map((backend: AgentBackend) => (
          <label key={backend} className="backend-toggle">
            <input
              type="checkbox"
              checked={state.backends.includes(backend)}
              onChange={(event) =>
                apply((prev) => setBackendAllowed(prev, backend, event.target.checked))
              }
            />
            {backend}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
