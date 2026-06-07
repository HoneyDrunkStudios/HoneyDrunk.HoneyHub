import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultClaudeCapabilities,
  oneShotCapabilities,
  wireProtocolVersion,
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
