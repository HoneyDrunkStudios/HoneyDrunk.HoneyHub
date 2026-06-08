# Changelog

## [0.13.0] - 2026-06-08

- Added an **Agents** tab: the user's own agent definitions, auto-discovered from `.claude/agents/` (Claude) and `.github/` files named `*agent*` (Copilot) within the allowlisted workspaces, listed grouped by backend with name, description, model, and the workspace-relative source path. Read-only and local; an empty state guides adding one; a generic error never leaks raw host text; queries the host only while active. Added `discoverAgents` to the `WireClient` seam (WebSocket + offline mock). Extracted the shared `backendLabel` helper so the spend/agents surfaces share one backend-naming source.

## [0.12.0] - 2026-06-08

- Added a **Coaching** tab: the cross-session coaching surface (ADR-0092 D4 / packet 09 §3e). It asks the host for the rules-based advisories (start a fresh session, watch a high-cost session, estimated figures are approximate) across every session on the device and renders them severity-first (warnings before info), each with a short title and the full guidance. States the advisory-only, local posture up front; shows an empty state when sessions look healthy; queries the host only while active. Added `requestCoachingHints` to the `WireClient` seam (WebSocket + offline mock).

## [0.11.0] - 2026-06-08

- Added a **Spend** tab: a device-wide "your spend" view that asks the host for a usage summary and renders measured dollars (Claude exact + Codex rate-derived) as the headline, with Copilot's premium-request activity shown separately so an estimate is never read as a measured cost. Per-backend rollups show cost (fidelity-prefixed), tokens, and turns; an empty state shows until the first run records usage. States the local-only posture up front; the tab only queries the host while it is active. Added `requestUsageSummary` to the `WireClient` seam (WebSocket + offline mock).

## [0.10.0] - 2026-06-08

- Added a per-session **Diagnostics** panel to the run screen: where the session was routed (provider · model + usage fidelity), token/cost usage for the whole session and the last turn, message count + elapsed time, and rules-based session-health recommendations (e.g. start a fresh session once it gets long). Cross-session suggestions remain a separate, later surface.

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
