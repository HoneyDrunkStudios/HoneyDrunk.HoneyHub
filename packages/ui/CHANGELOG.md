# Changelog

## [0.9.0] - 2026-06-08

- Version alignment for the host auto-open + mobile release (no UI code change).

## [0.8.0] - 2026-06-08

- Auto-connect to the bridge when the page is served by the host (same origin with a `?token=` query): the app derives the `/ws` URL from its own location via `bridgeWsUrl` and connects on load, so launching the host is the only step. The manual Bridge URL / Connect control remains for the dev-server workflow.

## [0.7.0] - 2026-06-07

- Added `WebSocketWireClient` (`wire/webSocketClient`) — a real transport behind the existing `WireClient` seam that talks to the bridge host over the `honeyhub.bridge.v1` WebSocket; queues commands until the socket opens and dispatches server events to subscribers.
- Added a toolbar **Bridge URL / Connect** control that swaps the run screen from the offline mock to a live bridge connection (paste the cockpit URL the host prints).

## [0.6.0] - 2026-06-07

- Added the chat-shaped run screen (`routes/run/RunScreen`): start a `claude.local` session, watch the token-level stream + run state, reply to `needs_input` and follow up after completion, stop a run, and see artifacts as links.
- Added a `WireClient` seam (`wire/client`) with a scripted `MockWireClient` (`wire/mockClient`) backing the offline demo and tests; the real WebSocket client lands with the bridge transport bringup.
- Added a fidelity-aware `UsageBadge` (exact/derived/estimated visually distinct; never renders an estimate as exact — ADR-0092 D2).
- Wired the run screen in as the default app view.

## [0.5.0] - 2026-06-07

- Added a Notifications view (list + unread badge) surfacing state-only notifications, behind a third app tab.

## [0.4.0] - 2026-06-07

- Updated workspace package version alignment for the Claude Code adapter release.

## [0.3.0] - 2026-06-07

- Added a bridge-settings view: pair/revoke devices (with one-time pairing-token display), manage the workspace-root allowlist (absolute-path validation, explicit errors), and toggle the backend allowlist.
- Added a pure, testable `bridgeSettings` model behind the view and a `Run`/`Bridge settings` tab switch in the app shell.

## [0.2.0] - 2026-06-07

- Updated workspace package version alignment for the bridge core contract release.

## [0.1.0] - 2026-06-07

- Added the initial React/Vite PWA shell, placeholder run surface, manifest, service worker registration, and render smoke test.
