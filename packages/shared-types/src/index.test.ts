import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultClaudeCapabilities,
  oneShotCapabilities,
  wireProtocolVersion,
  type Notification,
  type PairedDeviceView,
  type PairingGrant,
  type RunHandle,
  type WireFrame
} from "./index.js";

test("default Claude capabilities declare exact usage and live replies", () => {
  assert.equal(defaultClaudeCapabilities.interactive_reply, true);
  assert.equal(defaultClaudeCapabilities.usage_exact, true);
  assert.equal(defaultClaudeCapabilities.usage_estimated, false);
});

test("one-shot capabilities force replies through follow-up runs", () => {
  assert.equal(oneShotCapabilities.interactive_reply, false);
  assert.equal(oneShotCapabilities.stop_signal, false);
  assert.equal(oneShotCapabilities.usage_estimated, true);
});

test("wire frames carry the provisional bridge protocol version", () => {
  const frame: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-1",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "event-1",
      sessionId: "session-1",
      runId: "run-1",
      sequence: 1,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "status",
        status: {
          state: "running",
          backend: "claude.local",
          repoHint: "HoneyDrunk.HoneyHub"
        }
      }
    }
  };

  assert.equal(frame.protocol, "honeyhub.bridge.v1");
  assert.equal(frame.event?.payload.kind, "status");
});

test("paired device views omit the pairing token", () => {
  const view: PairedDeviceView = {
    deviceId: "device-1",
    displayName: "Pixel phone",
    pairedAt: "2026-06-07T12:00:00Z",
    revoked: false
  };

  assert.equal(view.revoked, false);
  assert.equal("token" in view, false);
});

test("pairing grants surface the token exactly once alongside a safe view", () => {
  const grant: PairingGrant = {
    device: {
      deviceId: "device-1",
      displayName: "Laptop",
      pairedAt: "2026-06-07T12:00:00Z",
      revoked: false
    },
    token: "one-time-token"
  };

  assert.equal(grant.token, "one-time-token");
  assert.equal("token" in grant.device, false);
});

test("notifications carry only state-only fields", () => {
  const notification: Notification = {
    id: "n1",
    kind: "pr_opened",
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    link: "https://example.test/pr/1",
    createdAt: "2026-06-07T12:00:00Z"
  };

  // Compile-time guard: if `Notification` ever gains a key outside this allowlist
  // (e.g. `body`/`task`/`path`), `Exclude<...>` stops being `never` and this fails
  // to type-check — the runtime `in` check alone could not catch that.
  type AllowedKey =
    | "id"
    | "kind"
    | "sessionId"
    | "runId"
    | "backend"
    | "repo"
    | "link"
    | "createdAt";
  type ExtraKeys = Exclude<keyof Notification, AllowedKey>;
  const _noExtraKeys: ExtraKeys extends never ? true : never = true;
  void _noExtraKeys;

  assert.equal(notification.kind, "pr_opened");
});

test("run handles may carry adapter process metadata", () => {
  const handle: RunHandle = {
    runId: "run-1",
    processId: 4321
  };

  assert.equal(handle.processId, 4321);
});
