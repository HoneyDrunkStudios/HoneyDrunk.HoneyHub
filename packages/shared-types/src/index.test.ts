import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultClaudeCapabilities,
  defaultCodexCapabilities,
  defaultCopilotCapabilities,
  oneShotCapabilities,
  wireProtocolVersion,
  type Notification,
  type PairedDeviceView,
  type PairingGrant,
  type RunHandle,
  type UsageSummary,
  type WireFrame
} from "./index.js";

test("default Claude capabilities declare exact usage and live replies", () => {
  assert.equal(defaultClaudeCapabilities.interactive_reply, true);
  assert.equal(defaultClaudeCapabilities.usage_exact, true);
  assert.equal(defaultClaudeCapabilities.usage_derived, false);
  assert.equal(defaultClaudeCapabilities.usage_estimated, false);
});

test("Codex capabilities declare resume-based replies and derived USD", () => {
  // Resume-based, so the core uses the follow-up-run path, not same-process.
  assert.equal(defaultCodexCapabilities.interactive_reply, false);
  assert.equal(defaultCodexCapabilities.resume_session, true);
  // Exact tokens, derived (rate-table) USD — exactly one usage flag set.
  assert.equal(defaultCodexCapabilities.usage_exact, false);
  assert.equal(defaultCodexCapabilities.usage_derived, true);
  assert.equal(defaultCodexCapabilities.usage_estimated, false);
});

test("Copilot capabilities declare premium-request estimated usage", () => {
  assert.equal(defaultCopilotCapabilities.interactive_reply, false);
  assert.equal(defaultCopilotCapabilities.usage_exact, false);
  assert.equal(defaultCopilotCapabilities.usage_derived, false);
  assert.equal(defaultCopilotCapabilities.usage_estimated, true);
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

test("usage summary keeps fidelities separate and grounds only measured spend", () => {
  const summary: UsageSummary = {
    sessionCount: 2,
    totalTurns: 3,
    rollups: [
      {
        backend: "claude.local",
        fidelity: "exact",
        turnCount: 2,
        inputTokens: 100,
        outputTokens: 60,
        totalTokens: 160,
        totalUsd: 0.15,
        durationMs: 1500
      },
      {
        backend: "copilot.local",
        fidelity: "estimated",
        turnCount: 1,
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        premiumRequests: 1,
        durationMs: 1800
      }
    ],
    // Grounded headline counts the exact rollup only; the estimated rollup carries
    // premium requests and no USD, so it stays out of the dollar figure.
    groundedTotalUsd: 0.15,
    totalPremiumRequests: 1
  };

  assert.equal(summary.groundedTotalUsd, 0.15);
  assert.equal(summary.rollups[1]?.totalUsd, undefined);
  assert.equal(summary.totalPremiumRequests, 1);
});

test("discover_agents carries an optional root and answers with an agent catalog", () => {
  const query: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-dq",
    kind: "client_command",
    createdAt: "2026-06-07T12:00:00Z",
    command: { kind: "discover_agents", workspaceRoot: "C:/work" }
  };
  assert.equal(query.command?.kind, "discover_agents");

  const event: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-de",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "agent_catalog",
        agents: [
          {
            id: "a1b2c3d4e5f6a7b8",
            name: "Reviewer",
            backends: [
              {
                backend: "claude.local",
                description: "Reviews diffs",
                sourcePath: ".claude/agents/reviewer.md",
                scope: "project",
                workspaceLabel: "work"
              }
            ]
          }
        ]
      }
    }
  };
  assert.equal(event.event?.payload.kind, "agent_catalog");
});

test("discover_backends is a fieldless query and answers with a backend catalog", () => {
  const query: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-bq",
    kind: "client_command",
    createdAt: "2026-06-07T12:00:00Z",
    command: { kind: "discover_backends" }
  };
  assert.equal(query.command?.kind, "discover_backends");

  const event: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-be",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "backend_catalog",
        backends: [
          {
            backend: "claude.local",
            program: "claude",
            available: true,
            capabilities: defaultClaudeCapabilities,
            models: [{ id: "opus", label: "Claude Opus 4.8" }],
            modelSource: "bridge_known"
          }
        ]
      }
    }
  };
  assert.equal(event.event?.payload.kind, "backend_catalog");
  if (event.event?.payload.kind === "backend_catalog") {
    assert.equal(event.event.payload.backends[0]?.available, true);
  }
});

test("coaching_hints is a fieldless query and a hint-bearing event", () => {
  const query: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-cq",
    kind: "client_command",
    createdAt: "2026-06-07T12:00:00Z",
    command: { kind: "coaching_hints" }
  };
  assert.equal(query.command?.kind, "coaching_hints");

  const event: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-ce",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "coaching_hints",
        hints: [
          {
            id: "coach:s1:stale_session",
            sessionId: "s1",
            code: "stale_session",
            severity: "warning",
            message: "This session is large.",
            createdAt: "2026-06-07T12:00:00Z"
          }
        ]
      }
    }
  };
  assert.equal(event.event?.payload.kind, "coaching_hints");
});

test("lsp commands carry a language id + opaque message; status flags degradation", () => {
  const send: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-lsp-send",
    kind: "client_command",
    createdAt: "2026-06-07T12:00:00Z",
    command: {
      kind: "lsp_send",
      root: "C:/work",
      languageId: "typescript",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" }
    }
  };
  assert.equal(send.command?.kind, "lsp_send");
  if (send.command?.kind === "lsp_send") {
    assert.equal(send.command.languageId, "typescript");
  }

  const status: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-lsp-status",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "lsp_status",
        status: {
          root: "C:/work",
          languageId: "python",
          serverId: "",
          installed: false,
          running: false,
          reason: "no language server is allowlisted for this language"
        }
      }
    }
  };
  assert.equal(status.event?.payload.kind, "lsp_status");
  if (status.event?.payload.kind === "lsp_status") {
    assert.equal(status.event.payload.status.installed, false);
    assert.equal(status.event.payload.status.languageId, "python");
  }
});

test("usage_summary is a fieldless client command and a payload-bearing event", () => {
  const query: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-q",
    kind: "client_command",
    createdAt: "2026-06-07T12:00:00Z",
    command: { kind: "usage_summary" }
  };
  assert.equal(query.command?.kind, "usage_summary");

  const event: WireFrame = {
    protocol: wireProtocolVersion,
    frameId: "frame-s",
    kind: "server_event",
    createdAt: "2026-06-07T12:00:00Z",
    event: {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-07T12:00:00Z",
      payload: {
        kind: "usage_summary",
        summary: {
          sessionCount: 0,
          totalTurns: 0,
          rollups: [],
          totalPremiumRequests: 0
        }
      }
    }
  };
  assert.equal(event.event?.payload.kind, "usage_summary");
});
