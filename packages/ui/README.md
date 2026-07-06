# @honeydrunk/honeyhub-ui

The one shared, responsive React + Vite PWA for HoneyHub — mobile and desktop from
a single codebase (ADR-0091 D2).

## Views

- **Run** (`routes/run/RunScreen`) — the chat-shaped run screen (ADR-0090 D4): pick a
  workspace root + backend (`claude.local`) + task and start; watch the token-level
  stream and run state; reply to `needs_input` (same-process) and follow up after a
  run completes; stop a run; and see produced artifacts (branch/PR/draft) as links.
  Per-session usage renders via a **fidelity-aware** `UsageBadge` that visually
  distinguishes exact / derived / estimated and never shows an estimate as an exact
  figure (ADR-0092 D2). A per-session **Diagnostics** panel shows where the session
  was routed (provider · model), session + last-turn token/cost usage, message
  count + elapsed time, and rules-based session-health recommendations.
- **Bridge settings** (`BridgeSettings`) — pair/revoke devices and edit the
  workspace + backend allowlists.
- **Notifications** (`NotificationList`) — state-only notifications (status/backend/
  repo/link only).

## Wire transport

The run screen depends only on the `wire/client` `WireClient` seam (the packet-04
protocol). `wire/mockClient` scripts a realistic Claude Code exchange for tests and
the offline demo; a real WebSocket client implementing the same seam — presenting the
pairing token on connect — lands with the bridge transport bringup. Per **PRD-0011
Amendment 2**, HoneyHub is now an **agent-first IDE**: it gains in-app code viewing and
editing (the Repositories page, via the ADR-0097 `write_file` boundary), but it is still
**not a terminal**.
