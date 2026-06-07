# Changelog

## [0.2.0] - 2026-06-07

- Added `BridgeRuntime` for backend-agnostic run lifecycle orchestration.
- Added transition validation and per-run `DispatchControlEvent` logs.
- Added provisional `honeyhub.bridge.v1` wire frames, commands, and server event payloads.
- Added process launch metadata, exit status handling, graceful stop timeout, and command-line secret redaction.
- Added workspace allowlist enforcement seam.

## [0.1.0] - 2026-06-07

- Added the initial Rust bridge crate skeleton with session, adapter, process, pairing, and artifact seams.
