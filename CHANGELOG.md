# Changelog

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
