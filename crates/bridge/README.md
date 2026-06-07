# honeyhub-bridge

Rust local runner bridge for HoneyHub.

The bridge core provides backend-agnostic lifecycle orchestration and the provisional
wire contract for local HoneyHub runners:

- `session` - run state, session entities, control events, and transition logging.
- `core` - `BridgeRuntime`, workspace policy checks, adapter capability checks, and run lifecycle orchestration.
- `adapter` - `AgentBackendAdapter` trait and the seven capability flags.
- `process` - process handle, exit status, graceful stop timeout, and command-line redaction.
- `pairing` - device identity and config-injected workspace allowlist seam.
- `artifact` - artifact metadata seam.
- `wire` - versioned client command and server event frames.

## State Machine

Runs move through this state path:

`created -> queued -> starting -> running -> needs_input -> finalizing -> completed`

The runtime also supports `stopping`, `failed`, and `cancelled` branches. Invalid
transitions return `BridgeError { code: "invalid_state_transition", ... }` and do
not mutate the run. Every valid transition appends a `DispatchControlEvent` to the
run's local event log.

## Backend Adapter Contract

`AgentBackendAdapter` declares seven capability flags before the bridge core calls
backend behavior:

- `streaming_output`
- `interactive_reply`
- `resume_session`
- `stop_signal`
- `structured_events`
- `usage_exact`
- `usage_estimated`

The runtime never calls undeclared live-reply or stop capabilities. `start`
returns a `RunHandle` that includes the run id and adapter-owned process id when
the backend launches a child process. If `interactive_reply` is false, `reply` is
routed through a follow-up run carrying the prior run id, workspace context, and
caller-provided follow-up task. Backend-specific CLI adapters land in later
packets.

## Process Lifecycle

`ProcessHandle` records the run id, process id when available, redacted launch
command, launch timestamp, and graceful stop timeout. Command-line fields that look
like tokens, API keys, secrets, or passwords are redacted before persistence.

`BridgeRuntime::stop` requests a graceful stop only when the adapter declares
`stop_signal`. `BridgeRuntime::handle_stop_timeout` records timeout escalation and
transitions the run to `failed` so clients do not wait forever in `stopping`.
`BridgeRuntime::handle_process_exit` transitions successful exits to `completed`
and unsuccessful exits to `failed`.

## Reconnect Replay

`BridgeRuntime` keeps an in-memory `BridgeEvent` log for each managed run. Local
lifecycle control events and adapter-streamed events are appended to the same log.
`BridgeRuntime::replay_events` accepts a `ReconnectRequest` and returns all events
for a run or session after `lastEventId`. This is a local runtime replay seam; later
storage packets can persist the same event stream across process restarts.

## Workspace Allowlist

The bridge core refuses starts outside the injected `WorkspaceAllowlist`. Packet 05
owns allowlist UX and persistence; this crate exposes the enforcement seam now.

## Wire Protocol [Provisional]

Protocol version: `honeyhub.bridge.v1`

Every frame is JSON and carries `protocol`, `frameId`, `kind`, and `createdAt`.
Client frames use `kind: "client_command"` and server frames use
`kind: "server_event"`.

Client commands:

- `start` - begins a run from `StartRunRequest`.
- `reply` - sends live input when `interactive_reply` is supported.
- `stop` - requests a graceful stop when `stop_signal` is supported.
- `resume` - resumes from a session id or transcript reference.
- `reconnect` - resumes event delivery from `sessionId`, optional `runId`, and optional `lastEventId`.

Server events:

- `message` - agent/user/system message payload.
- `control` - lifecycle control event payload.
- `usage` - exact, derived, or estimated usage signal.
- `policy_hint` - policy status relevant to the session.
- `status` - state-only notification with backend, repo hint, and optional link.

Status notifications intentionally exclude prompts, code, secrets, stack traces, and
full local paths.

Secure-context path for HTTPS PWA deployments: bundled desktop shells should use a
custom scheme or local IPC. Browser/PWA or tailnet deployments must use a TLS
terminating bridge endpoint or relay rather than assuming loopback-only HTTP.
