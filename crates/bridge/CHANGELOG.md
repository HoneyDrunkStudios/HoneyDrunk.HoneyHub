# Changelog

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
