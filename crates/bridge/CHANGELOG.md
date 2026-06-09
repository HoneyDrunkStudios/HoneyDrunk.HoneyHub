# Changelog

## [0.21.0] - 2026-06-09

- Agent discovery (§3f-bis) — folder + scope + dedupe rework (operator-decided):
  - **Copilot source corrected:** agents now come from **`.copilot/agents/*.md`** (Copilot's real convention — every markdown file in the folder is an agent), replacing the earlier `.github/`-files-named-`*agent*` heuristic. Both sources are now the same shape (a folder where every `*.md` is a definition), so the `FileMatch` distinction is gone.
  - **User-global scope (opt-in, off by default):** in addition to the per-workspace **project** folders (`<root>/.claude/agents`, `<root>/.copilot/agents`), the **user-global** folders `~/.claude/agents` and `~/.copilot/agents` can be scanned. Because that reads the user's own home config — outside the workspace allowlist — it is **not enabled by default** (ADR-0090 keeps discovery within configured roots): the host opts in via `BridgeRuntime::with_global_home(Some(home))` (resolve the home dependency-free with `user_home()`, which reads `HOME` then `USERPROFILE`); `None` (the default) disables it. When enabled the global scope is read **once**, independent of how many workspaces are scanned, and stays metadata-only with the 64 KiB cap and canonical-path **symlink containment against the home tree**.
  - **One entry per name, multiple backends:** definitions now dedupe by **name** into a single `AgentDefinition { id, name, backends }`, where each `AgentBackendBinding` carries that backend's winning metadata (`description`/`model`/`source_path`/`scope`/`workspace_label`). So a `reviewer` defined in both `.claude/agents` and `.copilot/agents` is **one** entry listing both backends; the caller picks the backend at dispatch. Within a backend, a **project** definition shadows a **global** one (ties break deterministically by label then path). `id` is now an opaque FNV hash of the **name** (no path embedded); a global binding labels itself with the constant `"global"` (the home basename is the username and is never leaked).
  - `BridgeRuntime::discover_agents` now collects raw candidates (project roots + the global scope), filters them **per backend** to what the runtime can **actually launch** — its single adapter's backend, and only when that backend is allowlisted (both gates `start` enforces) — then merges by name. A backend is dropped from an entry if it isn't launchable, and an entry is dropped only if no launchable backend remains, so the catalog never advertises a binding `start` would reject with `backend_mismatch` (e.g. a Claude-adapter runtime whose allowlist also lists Copilot must not offer `copilot.local`). New module API: `discover_raw_in_root`, `discover_raw_global_in`, `merge_agents`, `user_home`, plus `AgentScope`/`AgentBackendBinding`/`RawAgent`/`GLOBAL_LABEL`.
  - Wire (`honeyhub.bridge.v1`): the `AgentCatalog` event's `AgentDefinition` shape changes to the name-plus-backends model above (TS mirror updated in `shared-types`).

## [0.20.0] - 2026-06-08

- Added local **agent-definition discovery** (`agents` module / packet 09 §3f-bis): `discover_agents_in_root` reads the user's own agent definitions out of a workspace root and returns `AgentDefinition`s (metadata only — name/description/model/source, never the prompt body). Two operator-decided sources, table-driven: `.claude/agents/*.md` (every markdown file → `claude.local`) and `.github/` files whose name contains "agent" (→ `copilot.local`). Codex has no folder-of-agents convention and is not scanned. Best-effort (a missing folder/unreadable file is skipped); frontmatter parsing is a tiny dependency-free `key: value` reader; results are deterministically ordered; a large file is listed by name without parsing.
- `BridgeRuntime::discover_agents(workspace_root)` gates discovery on the **workspace allowlist** — `Some(root)` must be allowlisted (refused with `workspace_not_allowed` before any agent folder is scanned), `None` scans every allowlisted root — and filters results to the **backend allowlist**, so the catalog never advertises an agent on a backend the bridge is not allowed to launch (the same gate `start` enforces). No absolute local path crosses the wire: `source_path` is workspace-relative, `workspace_label` is the root's basename (hash-derived for a rootless root), and `id` hashes the root (ADR-0090 D11). A symlinked agent file or source folder that escapes the workspace is excluded by a canonical-path containment check (the folder is checked before it is even listed).
- Wire (`honeyhub.bridge.v1`): a `ClientCommand::DiscoverAgents { workspace_root? }` query and a device-scoped `BridgeEventPayload::AgentCatalog` server event (`BridgeEvent::agent_catalog`). The host answers the query and acks; an `AgentCatalog` payload seen in an adapter's run stream is rejected (`event_unexpected_agent_catalog`).

## [0.19.0] - 2026-06-08

- Wired the rules-based session coach (`coaching::coach`, added in 0.14.0) into a device-wide surface (ADR-0092 D4 / packet 09 §3e): `BridgeRuntime::coaching_hints(now)` runs the coach over **every** session the runtime holds and returns all advisory `PolicyHint`s. Each session's snapshot is built from its runs' transcripts (settled, non-partial message count) and recorded usage; `elapsed_minutes` is `None` (the crate stays clock-free and idle wall-time is a weak staleness signal — the token/message thresholds carry the `stale_session` rule). Advisory only — never a `Block` severity.
- Wire (`honeyhub.bridge.v1`): a fieldless `ClientCommand::CoachingHints` query and a device-scoped `BridgeEventPayload::CoachingHints` server event (`BridgeEvent::coaching_hints`, empty session/run ids, sequence 0). The host answers the query by computing `coaching_hints(now)` and emitting the event, then acks. A `CoachingHints` payload seen in an adapter's run stream is rejected (`event_unexpected_coaching_hints`) — host-synthesized, never streamed.

## [0.18.0] - 2026-06-08

- Added the device-wide **usage summary** ("your spend") aggregator (ADR-0092 D2 cost view): `UsageSummary::from_signals(signals, session_count)` rolls raw `UsageSignal`s up per `(backend, fidelity)`, keeping the three fidelities (`exact`/`derived`/`estimated`) in **separate** rollups so a measured cost is never summed with an estimate. The headline `grounded_total_usd` sums **exact + derived USD only** — estimated backends (Copilot bills premium requests, not a token cost) are excluded so a guess can't inflate it — and is `None` (not `0.00`) when no grounded signal carried a cost. Pure over its inputs, so the live runtime and a future persistent store share one summarization path.
- `BridgeRuntime::usage_summary()` reads each run's recorded usage events back out of its event log and rolls them up via the aggregator — a cross-session, host-lifetime summary with no new persistence wiring.
- Wire (`honeyhub.bridge.v1`): a fieldless `ClientCommand::UsageSummary` query and a device-scoped `BridgeEventPayload::UsageSummary` server event (`BridgeEvent::usage_summary`, empty session/run ids, sequence 0). The host answers the query by computing `usage_summary()` and emitting the event, then acks. A `UsageSummary` payload seen in an adapter's run stream is rejected (`event_unexpected_usage_summary`) — it is host-synthesized, never streamed.
- `AgentBackend` and `UsageFidelity` now derive `Hash`/`Ord` for deterministic `(backend, fidelity)` grouping and stable rollup ordering.

## [0.17.0] - 2026-06-08

- The fake CLI fixtures (`fake_claude`/`fake_codex`/`fake_copilot`) are now gated behind a `test-fixtures` cargo feature (`required-features`), so they are **not** built as product binary targets in a normal/release build (Grid invariant 16); the live-process integration tests are gated to match. CI's test/clippy steps pass `--features test-fixtures`; the product `build` step does not.
- A requested copilot follow-up whose prior run has no captured vendor session id now fails explicitly (`follow_up_session_missing`) rather than silently starting a fresh, context-losing run.
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
