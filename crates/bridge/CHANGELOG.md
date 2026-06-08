# Changelog

## [0.10.0] - 2026-06-08

- Version alignment for the session-diagnostics release (no bridge code change).

## [0.9.0] - 2026-06-08

- Version alignment for the host auto-open + mobile release (no bridge code change).

## [0.8.0] - 2026-06-08

- Version alignment for the turnkey-local-cockpit release (no bridge code change).

## [0.7.0] - 2026-06-07

- Added a public `clock` module (`now_rfc3339` + `format_rfc3339_utc`) so the adapter and the new bridge host stamp events with RFC3339 UTC timestamps without a date dependency; `default_event_clock` now uses it.

## [0.6.0] - 2026-06-07

- Version alignment for the run-screen release (no bridge code change).

## [0.5.0] - 2026-06-07

- Added `store::LocalStore`, a local-first session store: structured records (sessions/runs/control events/artifacts/usage/policy hints) in an embedded JSON document, transcript bodies in separate per-run JSONL files, with pin/unpin and a `prune(cutoff)` that drops unpinned, terminal, old transcripts while keeping durable records. Engine + retention window are `[Provisional]`; nothing syncs off-device.
- Added `notify` (ADR-0090 D7): a state-only `Notification` (status/backend/repo/link only, no field for prompt/code/path), derivation from run-state transitions (`needs_input`/`completed`/`failed`/`cancelled`) and from a persisted PR artifact (`PR opened`), and an in-app `NotificationCenter` transport seam.

## [0.4.0] - 2026-06-07

- Added the `claude.local` adapter (`adapters::claude_local`): drives the official Claude Code CLI in `stream-json` mode as a long-lived child process under the user's own local session, never holding or proxying subscription auth.
- `start`/`stream`/`reply`/`stop`/`resume`: replies are same-process live input written to the still-open stdin; `stop` kills the process tree (`taskkill /T` on Windows); `resume` re-attaches via a fresh `-r <session_id>` process. Unavailable/unauthenticated launches fail honestly with `backend_unavailable`.
- CLI JSONL is parsed into `BridgeEvent`s (assistant text + token deltas → messages, `needs_input` → status, artifacts → `DispatchArtifact`, `result` → exact tokens + USD `UsageSignal` taken directly, no rate-table computation).
- Added an `Artifact` `BridgeEventPayload` variant; `BridgeRuntime` collects streamed artifacts onto the run.
- Added a clock seam (`EventClock`) so the crate stays wall-clock-free while the adapter stamps live events.

## [0.3.0] - 2026-06-07

- Added `PairingRegistry` for the bridge trust boundary: per-device identity, user-initiated pairing that issues a revocable token, constant-time token verification, and device revocation.
- Added workspace-root allowlist lifecycle (`add_root`/`remove_root` with absolute-path and duplicate guards) and a typed `BackendAllowlist` (`AgentBackend` membership with add/remove).
- Wired the backend allowlist into `BridgeRuntime`: a launch against a backend outside the allowlist is refused (`backend_not_allowed`) before any process starts.
- Added `BridgeTrustConfig` (pairing + both allowlists) as a serializable, local-only unit; paired-device views never carry the token.

## [0.2.0] - 2026-06-07

- Added `BridgeRuntime` for backend-agnostic run lifecycle orchestration.
- Added transition validation and per-run `DispatchControlEvent` logs.
- Added replayable in-memory `BridgeEvent` logs for reconnect handling.
- Added provisional `honeyhub.bridge.v1` wire frames, commands, and server event payloads.
- Added process launch metadata, exit status handling, graceful stop timeout escalation, and command-line secret redaction.
- Added workspace allowlist enforcement seam.

## [0.1.0] - 2026-06-07

- Added the initial Rust bridge crate skeleton with session, adapter, process, pairing, and artifact seams.
