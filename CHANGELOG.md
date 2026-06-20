# Changelog

## [0.17.0] - 2026-06-20

Cockpit polish plus subscription-aware cost routing, driven by operator dogfooding.
(Version tracks: this changelog and the npm packages share the 0.17.0 user-facing
version; the Rust crate workspace is at 0.23.0 and the Tauri app build at 0.22.0, each
on its own internal track as in prior releases.)

- **Subscription-aware cost routing**: a new **Plans** surface (Settings, plus a skippable
  onboarding step) lets you declare each provider's plan (flat-rate vs metered, with a
  monthly price). In "Optimize cost" mode a flat-rate plan is treated as effectively free,
  so the router prefers a subscription you already pay for over a cheaper-per-token metered
  model, and the rationale says so when a plan flips the choice. Everything is optional. v1
  assumes headroom (real cap/usage ramping is a future refinement).
- **Unified model picker**: the manual "Pick model" control is now one custom dropdown that
  lists every model across backends and routes to the right provider on selection (the
  separate provider picker is gone). The active option carries a cyan outline; the native
  grey popup is replaced. Claude models now show full versioned names (Claude Opus 4.8,
  Claude Sonnet 4.6, Claude Haiku 4.5).
- **Composer**: a rotating set of cyberpunk and Matrix prompts (picked at random per visit)
  replaces the static heading; warmer composer styling, a bolder send arrow, and the stray
  blue focus ring removed.
- **Theming**: the unclassed grey buttons across Observe/Work/Jobs/Plan/Goals/Agents/
  Updates/Settings now match the neon theme (cyan/honey, destructive ones lean pink).
- **Copy**: em dashes removed from all user-facing strings.
- **Quality**: SonarCloud cleanup. Cognitive-complexity refactors in the bridge
  (`handle_command`, `validate_stream_payload`, `stream_events`, `strip_jsonc`,
  `search_files`, `parse_current_focus`) and ~130 TypeScript code-smell fixes across the UI,
  with no behavior change.
- **Security**: bumped `undici` 7.27.2 to 7.28.0 (transitive dev dependency) to clear a
  batch of advisories.

## [0.16.0] - 2026-06-15

HoneyHub grows from the v1 run cockpit into the local-first **control hub**: a Tauri
desktop app plus a set of new surfaces, multi-provider runs, and durable history. All
local-first and BYOK — the bridge still never holds vendor auth.

- **Desktop app** (`crates/desktop`, ADR-0091 §3f): a Tauri shell that folds the bridge +
  host **in-process** and opens the cockpit in a native window — one `cargo run -p
  honeyhub-desktop`, no browser, no sidecar. Binds a stable loopback port so webview
  storage persists; global agent discovery defaults on.
- **Multi-provider runtime**: the runtime now dispatches by backend across several adapters
  (Claude + Codex), so one cockpit drives both CLIs. Per-run **model** and Codex
  **reasoning-effort** (`-c model_reasoning_effort=`) are honored; models + reasoning levels
  are read from each CLI's real source (Codex cache; Claude aliases). Copilot is retained in
  the abstraction but not offered in the UI.
- **Agents**: launch a discovered agent from the chat (`--agent`, Claude), **author** new
  Claude agents in-app (the bridge's first guarded write path), and discovery now reaches
  **one level into sub-repos** so a parent-folder workspace surfaces per-repo agents.
- **New surfaces**: a **Runs** dashboard (every run's status/model/cost), bounded **Goals**
  (objective + caps → re-run loop feeding the runs board), a priorities/projects **Plan**
  roadmap (Now/Next/Later), a **Jobs** view (local processes + known-job health), **Git**
  (branch/ahead-behind/dirty + read-only diff), and **Updates** (installed CLI versions +
  new-model detection). All read-only where they touch the machine.
- **Activity**: tool/file activity (`tool_use` for Claude, `item.completed` for Codex) is
  surfaced in the chat right-panel — metadata only, never tool input/output.
- **Durable history**: the runtime mirrors sessions/runs/transcripts/usage to the
  local-first `LocalStore` (`HONEYHUB_STORE_DIR`, else `~/.honeyhub/store`); the cockpit
  lists synced sessions and reopens them read-only. (Continuing a past session across
  restarts — vendor-session reattach — is a follow-up.)
- **Composer**: chat-style run surface with a HoneyHub-native slash menu, an agent picker,
  a reasoning-effort picker, Enter-to-send, a non-typable workspace picker, and a
  read-only file **Browse** view (search + viewer). Cyberpunk-honey theme.
- **Read-only filesystem + workspace files**: directory browse, gated file reads,
  recursive filename search, and `.code-workspace` resolution to add several repos at once.
- **Connectors framework** (ADR-0094): an opt-in, read-only integrations registry — nothing
  on by default, each connector configured (and only then shown), no host-side secrets
  (reuses your existing `gh`/`az` sign-ins; Grafana/Sentry tokens held in the cockpit and
  passed per request). v1 catalog over two hubs — **Work** (GitHub assigned issues + your
  PRs + review requests; Azure DevOps work items) and **Observe** (Azure Service Bus
  queue/subscription + dead-letter counts; Grafana health + dashboards; Sentry unresolved
  errors) — plus a **Hub** overview that pulls each enabled connector's headline number into
  one glance. Per-panel "updated N ago" + auto-refresh; a Settings "Test connection".
- **Azure Service Bus explorer** (ADR-0094 D5): full data-plane parity behind an optional
  `honeyhub-sb-explorer` .NET helper (Azure SDK + `DefaultAzureCredential`, no connection
  string) — **peek** (browse a queue/subscription/dead-letter queue), **resubmit** a
  dead-letter message to its source, **purge**, **send**, and **receive** — read-only by
  default, with every destructive action behind an explicit in-UI confirmation.
- **Floating chat dock**: a popup AI chat docked on every screen but the full Chat tab,
  mounted app-wide so a conversation persists while you move between tabs (same run seam,
  streamed replies, follow-up continuity).
- **Connect a phone** (ADR-0091 mobile pairing): the bridge reports its reachable
  (tailnet/LAN) addresses; Settings + an onboarding step show a QR + URL — honest that a
  reachable bind (not just the QR) is what a phone needs.
- **Configurable jobs**: add your own job patterns to the Jobs view (matched on process name
  + command line); the agent-job set is now user-extensible.
- Refreshed brand: a centered `</>` mark (app icon + in-app) and cyan/neon-pink cyberpunk
  accents across the cockpit.

Versions: workspace crates 0.21.0 → 0.22.0; TS packages (root/ui/shell/types) 0.15.0 →
0.16.0. The optional `tools/honeyhub-sb-explorer` .NET helper is standalone (not in the npm
or cargo build) and is the only path that performs Service Bus data-plane writes.

## [0.15.0] - 2026-06-13

- Added the **routing engine** (ADR-0092 D3 / packet 09 §3d): an app-tier router suggests which backend to run a task on — capability-first for complex tasks, cost-first for light ones — reading a **bundled** cost-rate/policy snapshot (permitted for local-first apps under the invariant-45 local-first carve-out; HoneyHub owns the consumer schema; a HoneyDrunk.AI producer and fetch-and-cache delivery are follow-ups, since published model rates move only a few times a year). The run screen shows the suggestion + rationale and lets the user override. App-tier only — no new bridge/wire plumbing. The recent-usage ("optimize your own subscriptions") tiebreak ships as a tested hook but is not yet wired to live usage.
- Bumped the TS app packages (ui/shell/root 0.15.0); the bridge crate (0.21.0) and shared-types (0.15.0) are unchanged.

## [0.14.0] - 2026-06-09

- Agent discovery (§3f-bis) rework (operator-decided): Copilot agents now come from **`.copilot/agents/*.md`** (its real convention, replacing the `.github/*agent*` guess); the cockpit can also scan the **user-global** folders `~/.claude/agents` and `~/.copilot/agents` — **opt-in, off by default** (set `HONEYHUB_GLOBAL_AGENTS`), since that reads the user's own home config outside the workspace allowlist (ADR-0090); when enabled it is read once, metadata-only, with symlink containment. Definitions dedupe by **name** into **one entry runnable on the set of backends** that define it (a project definition shadows a global one within a backend). The Agents tab now shows one row per agent name with a badge per backend. Everything stays read-only and local; no prompt body or absolute path leaves the device. Discovery is filtered to the backends the runtime can actually launch (its adapter's backend, and only when allowlisted), so it never advertises an agent that `start` would reject.
- Bumped the bridge crate to 0.21.0 and the TS packages (types 0.15.0; ui/shell/root 0.14.0).

## [0.13.0] - 2026-06-08

- Added **agent discovery** (packet 09 §3f-bis): the cockpit auto-discovers the user's own agent definitions — every `.claude/agents/*.md` (Claude) and `.github/` files named `*agent*` (Copilot) — from within the workspace allowlist, read-only, and surfaces them in a new **Agents** tab grouped by backend. The bridge does the discovery (`BridgeRuntime::discover_agents`, allowlist-gated) and answers a new `discover_agents` wire query. Codex has no folder-of-agents convention, so it is not scanned. Metadata only; nothing is read outside the allowlist and no prompt body or absolute path leaves the device.
- Bumped the bridge crate to 0.20.0 and the TS packages (types 0.14.0; ui/shell/root 0.13.0).

## [0.12.0] - 2026-06-08

- Added the **coaching surface** (ADR-0092 D4 / packet 09 §3e): the rules-based session coach (shipped as a pure engine in 0.x) is now wired into a device-wide query. The bridge runs it over every session (`BridgeRuntime::coaching_hints`), answers a new `coaching_hints` wire query, and the PWA renders the advisories in a new **Coaching** tab — severity-first, advisory-only, local-only. No learned model (that stays a gated v2 decision).
- Bumped the bridge crate to 0.19.0 and the TS packages (types 0.13.0; ui/shell/root 0.12.0).

## [0.11.0] - 2026-06-08

- Added the **cost / "your spend" view** (ADR-0092 D2): a device-wide, local-only rollup of usage per backend. The bridge aggregates each run's usage into a `UsageSummary` (per-`(backend, fidelity)` rollups; grounded USD = exact + derived only, so an estimate can never inflate the headline; Copilot's premium requests shown separately), answers a new `usage_summary` wire query, and the PWA renders it in a new **Spend** tab. Nothing leaves the device.
- Bumped the bridge crate to 0.18.0 and the TS packages (types 0.12.0; ui/shell/root 0.11.0).

## [0.10.0] - 2026-06-08

- Added a per-session diagnostics panel to the run screen — routed provider/model, session + last-turn token/cost usage (with fidelity), message count + elapsed time, and rules-based session-health recommendations (when to start a fresh session). The cross-session suggestions surface is separate and later (Phase 3).
- Kept package versions aligned across the workspace at 0.10.0.

## [0.9.0] - 2026-06-08

- The bridge host now opens the cockpit in the browser on launch (skippable), so one command literally opens the app; and the README documents driving HoneyHub from a phone over a Tailscale tailnet from the same one binary (no separate mobile app).
- Kept package versions aligned across the workspace at 0.9.0.

## [0.8.0] - 2026-06-08

- Turnkey local cockpit: the bridge host now serves the built PWA and the WebSocket on one origin (axum — static at `/`, socket at `/ws`), and the PWA auto-connects when served that way. One command (`cargo run -p honeyhub-bridge-host`) opens an already-connected cockpit at the printed URL — the local server a Tauri shell will wrap unchanged.
- Kept package versions aligned across the workspace at 0.8.0.

## [0.7.0] - 2026-06-07

- Added the bridge **transport bringup** (ADR-0091 D2/D5): a new `crates/bridge-host` WebSocket server exposes the `BridgeRuntime` to the PWA over the `honeyhub.bridge.v1` protocol (pairing-token auth, command handling, event streaming), and a `WebSocketWireClient` + a toolbar Connect control let the run screen drive a live bridge instead of the offline mock. The README documents running a real Claude Code session end-to-end. WebSocket transport is `[Provisional]`; the bundled-desktop Tauri-IPC and mobile-Tailscale paths slot behind the same `WireClient` seam.
- Added a shared RFC3339 `clock` module in the bridge crate used by the adapter and host.
- Kept package versions aligned across the HoneyHub workspace at 0.7.0.

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
