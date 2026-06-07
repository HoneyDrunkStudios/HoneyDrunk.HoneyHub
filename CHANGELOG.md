# Changelog

## [0.2.0] - 2026-06-07

- Added the backend-agnostic Rust bridge runtime for packet 04, including run state transitions, control event logging, workspace allowlist enforcement, capability-gated replies/stops, process exit handling, and command-line secret redaction.
- Added the provisional `honeyhub.bridge.v1` wire protocol contract and mirrored shared TypeScript types.
- Kept package versions aligned across the HoneyHub workspace.

## [0.1.0] - 2026-06-07

- Scaffolded the HoneyHub mixed TypeScript/Rust workspace with React/Vite PWA, shell placeholder, shared session-contract types, Rust bridge skeleton, and dual-lane CI.
