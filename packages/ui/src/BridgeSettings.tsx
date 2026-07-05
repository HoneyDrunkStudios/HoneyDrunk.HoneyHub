import { useState } from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "./backends";
import { FolderBrowser } from "./routes/onboarding/FolderBrowser";
import { ConnectPhone } from "./routes/settings/ConnectPhone";
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

// The settings state is either controlled by a parent (SettingsModal, which owns the single
// bridge-settings object so every sub-page edits the same value) or, when used standalone (tests),
// managed internally. Shared here so each split sub-page resolves it the same way.
function useBridgeState(
  controlled: BridgeSettingsState | undefined,
  onChange: ((next: BridgeSettingsState) => void) | undefined,
  initialState: BridgeSettingsState | undefined
): { state: BridgeSettingsState; setState: (next: BridgeSettingsState) => void } {
  const [internal, setInternal] = useState<BridgeSettingsState>(initialState ?? emptyBridgeSettings);
  return {
    state: controlled ?? internal,
    setState: onChange ?? setInternal
  };
}

/** Props shared by the state-editing sub-pages. Controlled (`state` + `onChange`) in the modal;
    uncontrolled (`initialState`) when rendered standalone. */
interface SharedBridgeProps {
  initialState?: BridgeSettingsState;
  state?: BridgeSettingsState;
  onChange?: (next: BridgeSettingsState) => void;
}

// ------------------------------------------------------------------ Pairing & devices

export interface PairingSettingsProps extends SharedBridgeProps {
  factory?: PairingFactory;
  // The transport, so the connect-a-phone QR + address list can render. Its bridge
  // subscriptions only mount while this page is active.
  client?: WireClient;
  active?: boolean;
}

export function PairingSettings({
  initialState,
  state: controlledState,
  onChange,
  factory,
  client,
  active = true
}: Readonly<PairingSettingsProps>) {
  const { state, setState } = useBridgeState(controlledState, onChange, initialState);
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const apply = (compute: (prev: BridgeSettingsState) => BridgeSettingsState): boolean => {
    try {
      setState(compute(state));
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

  return (
    <section className="bridge-settings" aria-label="Pairing & devices">
      <h2>Pairing &amp; devices</h2>
      <p className="settings-group-hint">
        Pair a phone or another device with this cockpit, and manage the devices you have granted
        access.
      </p>

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
    </section>
  );
}

// ------------------------------------------------------------------ Workspace roots

export interface WorkspaceRootsSettingsProps extends SharedBridgeProps {
  // The transport, so the folder / `.code-workspace` picker can browse the filesystem. Its
  // bridge subscription only mounts while this page is active.
  client?: WireClient;
  active?: boolean;
}

export function WorkspaceRootsSettings({
  initialState,
  state: controlledState,
  onChange,
  client,
  active = true
}: Readonly<WorkspaceRootsSettingsProps>) {
  const { state, setState } = useBridgeState(controlledState, onChange, initialState);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const apply = (compute: (prev: BridgeSettingsState) => BridgeSettingsState): boolean => {
    try {
      setState(compute(state));
      setError(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "unexpected error");
      return false;
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
    <section className="bridge-settings" aria-label="Workspace roots">
      <h2>Workspace roots</h2>
      <p className="settings-group-hint">
        The repository folders the agent may read and launch in. Add a root by browsing or by
        absolute path.
      </p>

      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}

      {client !== undefined && active && (
        <>
          <p className="ws-browse-label">Browse for a folder or a .code-workspace file</p>
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
    </section>
  );
}

// ------------------------------------------------------------------ Providers & models

export interface ProvidersModelsSettingsProps extends SharedBridgeProps {
  // The detected backend catalog, so each provider toggle shows "detected / not found" and its
  // models are listed.
  catalog?: BackendCapability[];
}

export function ProvidersModelsSettings({
  initialState,
  state: controlledState,
  onChange,
  catalog = []
}: Readonly<ProvidersModelsSettingsProps>) {
  const { state, setState } = useBridgeState(controlledState, onChange, initialState);
  const [error, setError] = useState<string | undefined>(undefined);

  // Detection lookup so each toggle can show whether the CLI was found on PATH.
  const detected = new Map<AgentBackend, BackendCapability>(
    catalog.map((entry) => [entry.backend, entry])
  );

  const apply = (compute: (prev: BridgeSettingsState) => BridgeSettingsState): void => {
    try {
      setState(compute(state));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "unexpected error");
    }
  };

  // Extracted from the model-toggle JSX so the change handler isn't a deeply nested function.
  const onModelToggle = (
    backend: AgentBackend,
    modelId: string,
    allowed: boolean,
    modelIds: string[]
  ) => {
    apply((prev) => setModelAllowed(prev, backend, modelId, allowed, modelIds));
  };

  return (
    <section className="bridge-settings" aria-label="Providers & models">
      <h2>Providers &amp; models</h2>
      <p className="settings-group-hint">
        Enable the agent CLIs you have installed, then choose which of their models to allow.
      </p>

      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}

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
                          onModelToggle(backend, model.id, event.target.checked, modelIds)
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
    </section>
  );
}
