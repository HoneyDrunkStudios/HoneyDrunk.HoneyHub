import { useState } from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "./backends";
import { FolderBrowser } from "./routes/onboarding/FolderBrowser";
import { ConnectPhone } from "./routes/settings/ConnectPhone";
import { ConnectorsSettings } from "./routes/settings/ConnectorsSettings";
import type { WireClient } from "./wire/client";
import {
  acknowledgeGrant,
  addWorkspaceRoot,
  allBackends,
  emptyBridgeSettings,
  isModelEnabled,
  pairDevice,
  removeWorkspaceRoot,
  revokeDevice,
  setBackendAllowed,
  setModelAllowed,
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
  // The detected backend catalog, so the same provider toggles shown at first run
  // are editable here with live "detected / not found" status.
  catalog?: BackendCapability[];
  // The transport, so the workspace-roots picker can browse the filesystem + resolve
  // `.code-workspace` files. When omitted, only the manual path field is shown.
  client?: WireClient;
  // Whether this view is the active one. The folder picker subscribes to bridge
  // events, so it is only mounted when active to avoid cross-talk with the Browse
  // view (both react to the shared `dir_listing` stream). Defaults to true.
  active?: boolean;
}

export function BridgeSettings({
  initialState,
  factory,
  state: controlledState,
  onChange,
  catalog = [],
  client,
  active = true
}: Readonly<BridgeSettingsProps>) {
  // Detection lookup so each toggle can show whether the CLI was found on PATH.
  const detected = new Map<AgentBackend, BackendCapability>(
    catalog.map((entry) => [entry.backend, entry])
  );
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

  // Add one or more roots from the folder/workspace-file picker, skipping any that are
  // invalid or already present (no error for those, unlike the single manual add).
  const addRoots = (paths: string[]) => {
    let next = state;
    for (const path of paths) {
      try {
        next = addWorkspaceRoot(next, path);
      } catch {
        // skip duplicates / non-absolute paths from the picker
      }
    }
    setState(next);
    setError(undefined);
  };

  const onAddRoot = () => {
    if (apply((prev) => addWorkspaceRoot(prev, workspaceRoot))) {
      setWorkspaceRoot("");
    }
  };

  return (
    <section className="bridge-settings" aria-label="Settings">
      <h2>Settings</h2>

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

      {client !== undefined && <ConnectPhone client={client} active={active} />}

      <ConnectorsSettings {...(client !== undefined ? { client } : {})} />

      <fieldset>
        <legend>Workspace roots</legend>
        {client !== undefined && active && (
          <>
            <label>Browse for a folder or a .code-workspace file</label>
            <FolderBrowser client={client} onAddRoots={addRoots} />
          </>
        )}
        <label htmlFor="workspace-root">Or enter an absolute path</label>
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
        <legend>Providers &amp; models</legend>
        {allBackends.map((backend: AgentBackend) => {
          const entry = detected.get(backend);
          const models = entry?.models ?? [];
          const modelIds = models.map((model) => model.id);
          const providerOn = state.backends.includes(backend);
          return (
            <div key={backend} className="provider-config">
              <label className="backend-toggle">
                <input
                  type="checkbox"
                  checked={providerOn}
                  onChange={(event) =>
                    apply((prev) => setBackendAllowed(prev, backend, event.target.checked))
                  }
                />
                <span className="backend-toggle-name">{backendLabel(backend)}</span>
                {entry !== undefined && (
                  <span
                    className={`provider-chip ${entry.available ? "is-detected" : "is-missing"}`}
                  >
                    {entry.available ? "Detected" : "Not found"}
                  </span>
                )}
              </label>
              {models.length > 0 && (
                <ul className="model-toggles" aria-label={`${backendLabel(backend)} models`}>
                  {models.map((model) => (
                    <li key={model.id}>
                      <label className="model-toggle">
                        <input
                          type="checkbox"
                          checked={isModelEnabled(state, backend, model.id)}
                          disabled={!providerOn}
                          onChange={(event) =>
                            apply((prev) =>
                              setModelAllowed(
                                prev,
                                backend,
                                model.id,
                                event.target.checked,
                                modelIds
                              )
                            )
                          }
                        />
                        {model.label}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </fieldset>
    </section>
  );
}
