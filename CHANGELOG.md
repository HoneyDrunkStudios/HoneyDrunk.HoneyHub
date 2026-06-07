# Changelog

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
