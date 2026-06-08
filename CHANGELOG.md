# Changelog

## [0.13.0] - 2026-06-08

- Added **agent discovery** (packet 09 §3f-bis): the cockpit auto-discovers the user's own agent definitions — every `.claude/agents/*.md` (Claude) and `.github/` files named `*agent*` (Copilot) — from within the workspace allowlist, read-only, and surfaces them in a new **Agents** tab grouped by backend. The bridge does the discovery (`BridgeRuntime::discover_agents`, allowlist-gated) and answers a new `discover_agents` wire query. Codex has no folder-of-agents convention, so it is not scanned. Metadata only; nothing is read outside the allowlist and no prompt body or absolute path leaves the device.
- Bumped the bridge crate to 0.20.0 and the TS packages (types 0.14.0; ui/shell/root 0.13.0).

## [0.12.0] - 2026-06-08

- Added the **coaching surface** (ADR-0092 D4 / packet 09 §3e): the rules-based session coach (shipped as a pure engine in 0.x) is now wired into a device-wide query. The bridge runs it over every session (`BridgeRuntime::coaching_hints`), answers a new `coaching_hints` wire query, and the PWA renders the advisories in a new **Coaching** tab — severity-first, advisory-only, local-only. No learned model (that stays a gated v2 decision).
- Bumped the bridge crate to 0.19.0 and the TS packages (types 0.13.0; ui/shell/root 0.12.0).

## [0.11.0] - 2026-06-08

- Added the **cost / "your spend" view** (ADR-0092 D2): a device-wide, local-only rollup of usage per backend. The bridge aggregates each run's usage into a `UsageSummary` (per-`(backend, fidelity)` rollups; grounded USD = exact + derived only, so an estimate can never inflate the headline; Copilot's premium requests shown separately), answers a new `usage_summary` wire query, and the PWA renders it in a new **Spend** tab. Nothing leaves the device.
- Bumped the bridge crate to 0.18.0 and the TS packages (types 0.12.0; ui/shell/root 0.11.0).

## [0.10.0] - 2026-06-08

- Added a per-session diagnostics panel to the run screen — routed provider/model, session + last-turn token/cost usage (with fidelity), message count + elapsed time, and rules-based session-health recommendations (when to start a fresh session). The cross-session suggestions surface is separate and later (Phase 3).
- Kept package versions aligned across the workspace at 0.10.0.

## [0.9.0] - 2026-06-08

- The bridge host now opens the cockpit in the browser on launch (skippable), so one command literally opens the app; and the README documents driving HoneyHub from a phone over a Tailscale tailnet from the same one binary (no separate mobile app).
- Kept package versions aligned across the workspace at 0.9.0.

## [0.8.0] - 2026-06-08

- Turnkey local cockpit: the bridge host now serves the built PWA and the WebSocket on one origin (axum — static at `/`, socket at `/ws`), and the PWA auto-connects when served that way. One command (`cargo run -p honeyhub-bridge-host`) opens an already-connected cockpit at the printed URL — the local server a Tauri shell will wrap unchanged.
- Kept package versions aligned across the workspace at 0.8.0.

## [0.7.0] - 2026-06-07

- Added the bridge **transport bringup** (ADR-0091 D2/D5): a new `crates/bridge-host` WebSocket server exposes the `BridgeRuntime` to the PWA over the `honeyhub.bridge.v1` protocol (pairing-token auth, command handling, event streaming), and a `WebSocketWireClient` + a toolbar Connect control let the run screen drive a live bridge instead of the offline mock. The README documents running a real Claude Code session end-to-end. WebSocket transport is `[Provisional]`; the bundled-desktop Tauri-IPC and mobile-Tailscale paths slot behind the same `WireClient` seam.
- Added a shared RFC3339 `clock` module in the bridge crate used by the adapter and host.
- Kept package versions aligned across the HoneyHub workspace at 0.7.0.

## [0.6.0] - 2026-06-07

- Added the minimal chat-shaped run screen for packet 08 — the Phase 2 integration capstone: start a Claude Code session, watch the live stream + run state, reply to `needs_input`, follow up after completion, stop, and see artifact links, with fidelity-aware usage display. Built on a `WireClient` seam with a scripted mock for tests/offline demo (the real WebSocket transport lands with the bridge bringup).
- Kept package versions aligned across the HoneyHub workspace.

## [0.5.0] - 2026-06-07

- Added the local-first session store for packet 07: structured records in an embedded JSON document + separable per-run transcript files, with pin/prune retention (engine + window `[Provisional]`, nothing syncs off-device).
- Added a state-only notification seam (ADR-0090 D7) — `needs_input`/`completed`/`failed`/`cancelled`/`PR opened`, carrying status/backend/repo/link only — mirrored into shared-types and surfaced as a PWA Notifications view.
- Kept package versions aligned across the HoneyHub workspace.

## [0.4.0] - 2026-06-07

- Added the `claude.local` backend adapter for packet 06: drives the official Claude Code CLI under the user's own local session (no subscription auth held or proxied), with same-process live reply, process-tree stop, session resume, exact tokens + USD usage, artifact detection, and honest failure when the CLI is unavailable.
- Extended the bridge wire protocol with an artifact stream event (mirrored in shared-types) and a clock seam for stamping live adapter events.
- Added a live duplex fake-`claude` test fixture and an integration test exercising start → stream → needs_input → reply → stop → resume.
- Kept package versions aligned across the HoneyHub workspace.

## [0.3.0] - 2026-06-07

- Added the bridge trust boundary for packet 05: per-device identity, user-initiated revocable pairing tokens, workspace-root allowlist lifecycle, and a backend allowlist wired into the runtime launch gate.
- Added a PWA bridge-settings surface to pair/revoke devices and edit the workspace-root and backend allowlists, plus matching token-free pairing view types in shared-types.
- Kept package versions aligned across the HoneyHub workspace.

## [0.2.0] - 2026-06-07

- Added the backend-agnostic Rust bridge runtime for packet 04, including run state transitions, control event logging, workspace allowlist enforcement, capability-gated replies/stops, process exit handling, and command-line secret redaction.
- Added the provisional `honeyhub.bridge.v1` wire protocol contract and mirrored shared TypeScript types.
- Kept package versions aligned across the HoneyHub workspace.

## [0.1.0] - 2026-06-07

- Scaffolded the HoneyHub mixed TypeScript/Rust workspace with React/Vite PWA, shell placeholder, shared session-contract types, Rust bridge skeleton, and dual-lane CI.
