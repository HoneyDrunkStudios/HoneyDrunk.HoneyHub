# Changelog

## [0.21.0] - 2026-06-09

- Added the `HONEYHUB_GLOBAL_AGENTS` env opt-in: when set to a non-empty value the host enables user-global agent discovery (`~/.claude/agents`, `~/.copilot/agents`) via `BridgeRuntime::with_global_home(user_home())`. Off by default — that scope reads outside the workspace allowlist (the user's own home config), so it is only scanned when the operator explicitly enables it (ADR-0090).

## [0.17.0] - 2026-06-08

- Version alignment for the `copilot.local` adapter (no host code change).

## [0.16.0] - 2026-06-08

- Version alignment for the `codex.local` adapter (no host code change).

## [0.15.0] - 2026-06-08

- Version alignment for the shared `child_run` adapter-driver extraction + lifecycle hardening (no host code change).

## [0.14.0] - 2026-06-08

- Version alignment for the rules-based coaching module (no host code change).

## [0.10.0] - 2026-06-08

- Version alignment for the session-diagnostics release (no host code change).

## [0.9.0] - 2026-06-08

- On start, when serving the PWA, open the cockpit in the default browser (skippable with `HONEYHUB_NO_BROWSER`) — so `cargo run -p honeyhub-bridge-host` opens an already-connected cockpit. Documented the mobile-over-Tailscale flow (bind `0.0.0.0`, open from the phone over the tailnet).

## [0.8.0] - 2026-06-08

- Serve the built PWA and the WebSocket on one local origin (axum): static assets at `/`, the bridge socket at `/ws`. Configurable via `HONEYHUB_STATIC_DIR` (defaults to `packages/ui/dist` when present). With it, one command runs the whole cockpit and the page auto-connects; without it, only `/ws` is exposed.
- Reworked the WebSocket transport onto axum (query-decoded token auth, broadcast streaming, ack/error correlation, fail-fast on lag preserved). Integration tests cover WS streaming, token rejection, and static serving.

## [0.7.0] - 2026-06-07

- Initial bridge host: a localhost WebSocket server that exposes a `BridgeRuntime` to the PWA over the `honeyhub.bridge.v1` wire protocol. Authenticates each connection by pairing token (query parameter), maps `ClientCommand` frames to runtime calls, polls the runtime's event stream, and broadcasts `server_event` frames to connected clients. Binary configured via environment (`HONEYHUB_BRIDGE_ADDR`, `HONEYHUB_WORKSPACE_ROOTS`, `HONEYHUB_CLAUDE_PROGRAM`, `HONEYHUB_CLAUDE_MODEL`). WebSocket transport is `[Provisional]` (ADR-0091 D5).
