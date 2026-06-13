import { describe, expect, it } from "vitest";
import {
  acknowledgeGrant,
  addWorkspaceRoot,
  defaultPairingFactory,
  emptyBridgeSettings,
  isAbsoluteWorkspaceRoot,
  pairDevice,
  removeWorkspaceRoot,
  revokeDevice,
  setBackendAllowed,
  type PairingFactory
} from "./settingsModel";

function fixedFactory(seed: string): PairingFactory {
  let counter = 0;
  return {
    deviceId: () => `${seed}-device-${counter++}`,
    token: () => `${seed}-token`,
    now: () => "2026-06-07T12:00:00Z"
  };
}

describe("defaultPairingFactory", () => {
  it("produces a dash-free hex token, a device id, and an ISO timestamp", () => {
    const token = defaultPairingFactory.token();
    // Two concatenated UUIDs with the dashes stripped.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain("-");

    expect(defaultPairingFactory.deviceId()).not.toBe(defaultPairingFactory.deviceId());
    expect(defaultPairingFactory.now()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("bridge settings model", () => {
  it("pairs a device and surfaces the token exactly once", () => {
    const paired = pairDevice(emptyBridgeSettings, "Pixel", fixedFactory("a"));

    expect(paired.devices).toHaveLength(1);
    const [device] = paired.devices;
    expect(device?.revoked).toBe(false);
    expect(paired.lastGrant?.token).toBe("a-token");
    // The persisted device view never carries the token.
    expect(device !== undefined && "token" in device).toBe(false);

    const acknowledged = acknowledgeGrant(paired);
    expect(acknowledged.lastGrant).toBeUndefined();
    expect(acknowledged.devices).toHaveLength(1);
  });

  it("rejects an empty device name", () => {
    expect(() => pairDevice(emptyBridgeSettings, "  ", fixedFactory("a"))).toThrow(
      /required/
    );
  });

  it("revokes a paired device and errors on unknown ids", () => {
    const paired = pairDevice(emptyBridgeSettings, "Laptop", fixedFactory("b"));
    const id = paired.devices[0]?.deviceId ?? "";

    const revoked = revokeDevice(paired, id);
    expect(revoked.devices[0]?.revoked).toBe(true);

    expect(() => revokeDevice(revoked, "missing")).toThrow(/not paired/);
  });

  it("accepts absolute workspace roots and rejects relative or duplicate ones", () => {
    expect(isAbsoluteWorkspaceRoot("/home/dev/work")).toBe(true);
    expect(isAbsoluteWorkspaceRoot("C:/work/honeyhub")).toBe(true);
    expect(isAbsoluteWorkspaceRoot("C:\\work")).toBe(true);
    expect(isAbsoluteWorkspaceRoot("relative/path")).toBe(false);

    const withRoot = addWorkspaceRoot(emptyBridgeSettings, "C:/work/honeyhub");
    expect(withRoot.workspaceRoots).toEqual(["C:/work/honeyhub"]);

    expect(() => addWorkspaceRoot(withRoot, "relative/path")).toThrow(/absolute/);
    expect(() => addWorkspaceRoot(withRoot, "C:/work/honeyhub")).toThrow(/already/);
  });

  it("removes workspace roots and errors on absent ones", () => {
    const withRoot = addWorkspaceRoot(emptyBridgeSettings, "/home/dev/work");
    const removed = removeWorkspaceRoot(withRoot, "/home/dev/work");
    expect(removed.workspaceRoots).toEqual([]);
    expect(() => removeWorkspaceRoot(removed, "/home/dev/work")).toThrow(/not on/);
  });

  it("toggles backend allowlist membership idempotently", () => {
    let state = setBackendAllowed(emptyBridgeSettings, "claude.local", true);
    expect(state.backends).toEqual(["claude.local"]);

    // Re-enabling an already-allowed backend is a no-op (same reference).
    expect(setBackendAllowed(state, "claude.local", true)).toBe(state);

    state = setBackendAllowed(state, "claude.local", false);
    expect(state.backends).toEqual([]);
    expect(setBackendAllowed(state, "claude.local", false)).toBe(state);
  });
});
