# Changelog

## [0.7.0] - 2026-06-07

- Initial bridge host: a localhost WebSocket server that exposes a `BridgeRuntime` to the PWA over the `honeyhub.bridge.v1` wire protocol. Authenticates each connection by pairing token (query parameter), maps `ClientCommand` frames to runtime calls, polls the runtime's event stream, and broadcasts `server_event` frames to connected clients. Binary configured via environment (`HONEYHUB_BRIDGE_ADDR`, `HONEYHUB_WORKSPACE_ROOTS`, `HONEYHUB_CLAUDE_PROGRAM`, `HONEYHUB_CLAUDE_MODEL`). WebSocket transport is `[Provisional]` (ADR-0091 D5).
