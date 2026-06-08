# Changelog

## [0.17.0] - 2026-06-08

- Added the `copilot.local` adapter (`adapters::copilot_local::CopilotLocalAdapter`): drives the official GitHub Copilot CLI under the user's own local `gh` token (ADR-0090 §3b), as a thin strategy over the shared `child_run` driver — completing the three v1 backends.
- Token-level streaming: `assistant.message_delta` deltas → partial messages; `assistant.message_completed` carries the final assembled message; `turn.completed` carries the usage signal. Resume-based reply (the core's follow-up-run path). CLI shape isolated to `exec_command`. Tail drain + child drop off the runs lock; a session id seen only in the drained tail is written back to the retired slot.
- Usage fidelity `estimated` (ADR-0092 D2): premium-requests + duration are the exact billing units; token figures are estimated from a coarse text-size proxy (ceiling division so any non-empty text is ≥ 1 token; a **final-text-only** response — no streamed deltas — still estimates non-zero output tokens). USD absent (Copilot bills premium requests, not a token cost).
- Usage is accounted **exactly once per turn**: a second terminal line in the same drain (`usage_already_emitted`) cannot double-count the premium request; `assistant.message_completed` carries no usage. Completion events adopt a session id only from explicit `session_id`/`thread_id` (never a generic `id`) and never overwrite the id captured at init.

## [0.16.0] - 2026-06-08

- Added the `codex.local` adapter (`adapters::codex_local::CodexLocalAdapter`): drives the official Codex CLI's non-interactive `codex exec --json` mode under the user's own local session (ADR-0090 §3a), as a thin strategy over the shared `child_run` driver. Resume-based (`interactive_reply` false → the core's follow-up-run path); parses `thread.started`/`session.created`, `item.completed` (agent-message items only), and `turn.completed`.
- Usage fidelity `derived` (ADR-0092 D2): exact tokens taken directly, USD computed via an injected `UsdRateLookup` (the operator-configurable rate table); with no rate wired, tokens stay exact and USD is absent — never fabricated. Added `usage_derived` to `CapabilityFlags` (the spike's third usage shape) + `codex_local()`/`copilot_local()` presets, mirrored in the TS shared-types.
- The resumed command places `--json` immediately after `exec`, before the `resume` subcommand (`codex exec --json resume <session> <task>`) — the shape the CLI requires for reliable non-interactive resume; covered by command-shape unit tests. A follow-up whose prior run has no captured vendor session id fails explicitly (`follow_up_session_missing`).
- **Core:** `BridgeRuntime::reply` lets a terminal run start a follow-up when the backend is resume-based (`interactive_reply` false + `resume_session`) — a completed `codex exec` turn is a valid reply target. The `terminal_run_reply` rejection now applies only to interactive backends. Added a runtime regression test.
- `stream()` does the bounded tail drain + child drop off the runs lock; a vendor session id discovered only in the drained tail is written back into the retired slot for a later resume.

## [0.15.0] - 2026-06-08

- Extracted the shared child-process driver into `adapters::child_run` (`ChildRun`): spawn-with-piped-stdio, stderr drain, stdout reader thread, process-tree kill, reap, and one-time exit detection now live in one place. `claude.local` is now a thin strategy over it (command + capability flags + `stream-json` parsing + same-process reply framing), so the `codex.local` / `copilot.local` adapters reuse the mechanics rather than copying them. `EventClock` / `default_event_clock` moved to `child_run` and are re-exported unchanged.
- Hardened process teardown: the tree is killed exactly once (`kill_tree_once`, idempotent across `close_and_kill` + `Drop`), which both cleans up any descendant that outlived the direct CLI and forces stdout to EOF so the reader-thread join in `Drop` is bounded. A small recycle window remains on the unix group-signal-after-reap path (a group signal only hits a process that became a group *leader* with the recycled pid — far less likely than a bare `kill(pid)`); accepted for v1, with the recycle-immune fix (Linux `pidfd` / Windows job objects) tracked in HoneyHub#26.
- A spawn failure now names the exact program (`failed to launch backend CLI '<program>'`).
- Added `RunSlot` (`Live`/`Done`): a completed run **retires** to a lightweight record that keeps only the captured vendor `backend_session_id`, dropping the child handle, reader thread, and channel — freeing a long-lived host from accumulating finished runs while still letting a follow-up turn resume the session.
- Added `ChildRun::drain_remaining(timeout)`: a bounded, timeout-aware (`recv_timeout`) final drain of the stdout the child flushed on exit, so the closing `result`/usage line (exact tokens + USD) is never lost when the channel is dropped on retirement. `stream()` retires under the runs lock (capturing the early-set vendor session id), then performs the tail drain and the child drop (which joins the reader thread) **off** the lock, so neither the bounded drain nor the join blocks another run's `stream`/`reply`/`stop`.
- If the vendor session id only appears in a line drained from that off-lock tail (rather than the early init event), it is written back into the retired `Done` slot (`RunSlot::set_done_backend_session_id`) so a later follow-up resume still sees it.

## [0.14.0] - 2026-06-08

- Added `coaching` (ADR-0092 D4 / packet 09 §3e): a rules-based session coach that emits advisory `PolicyHint`s from a pure `coach(&CoachingSnapshot)` over session/usage state — `stale_session` (large token context / many messages / long runtime → start fresh), `high_cost_session` (grounded exact/derived spend over a threshold), and `estimate_only_spend` (premium-request backends; figures are approximate). Advisory only — never emits a `Block` severity (ADR-0092 D2/D4 warning-only posture); the grounded-spend rule excludes estimated USD so a guess can't drive a warning. No learned model (the per-user learned coach stays a gated v2 decision). The routing-dependent rules (`routing_hint`/`mode_fit`/`subscription_optimization`) are deferred to land with the routing engine (§3d).

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
