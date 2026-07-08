# Changelog

## [Unreleased]

Dogfooding round: smarter cost signals, hardened group checks, a resizable chat dock, and a
user-centered Jobs page.

- **Project launch** (PRD-0013 / ADR-0104): a Launch page detects how each allowlisted repo runs
  (a host-owned table maps `.sln`/`.csproj` to dotnet, `package.json` scripts to npm, `Cargo.toml`
  to cargo) and runs a chosen target as a supervised child process, streaming its stdout/stderr to
  a scrolling log. The offered targets are host-owned and a start is resolved against them, so an
  unknown or un-offered id is refused (never an arbitrary command over the wire); a single-project
  folder offers `run`, but an ambiguous solution offers only build/test. Each launch runs in its
  own process group with sensitive-named env vars scrubbed, is owned by the connection that started
  it (only the owner sees its output or can stop it), and is tree-killed on stop, exit, root
  removal, or disconnect. Unlike the terminal, launch is relay-reachable, so a relay start does not
  spawn immediately: the host parks it and the owning cockpit must confirm before it runs
  (ADR-0104 D3).
- **Integrated terminal** (PRD-0013 / ADR-0103): a Terminal page runs a real shell (via a PTY)
  inside an allowlisted workspace root, rendered with xterm. It is desktop-local-only by design
  (a relay connection is refused, ADR-0103 D3) and host-supervised: each session is owned by the
  connection that opened it (only the owner can write, resize, or read its output; no other
  cockpit sees the stream), registration re-checks the root allowlist under the same lock that
  removes it (so a concurrent root removal cannot leave a shell in a de-authorized tree), the
  per-connection session count is capped, and every session is tree-killed on close, shell exit,
  idle timeout, root removal, or disconnect. Session contents are never logged; only an
  open/close audit line (session id, root, owning connection) reaches the bridge console.
- **Repo-wide search**: a Search panel on the activity rail greps every allowlisted workspace
  root from the bridge (read-posture, ADR-0090 D8), with per-file grouping and click-to-open.
  The same query also matches **file names**: files whose name contains the query (search for a
  ticket or refinement number and jump straight to its file) are listed above the content
  matches, click-to-open. A ripgrep failure (for example an invalid regex) now surfaces as an
  explicit error instead of silently-empty results, and a stale result for a superseded query,
  scope, or flag combination can no longer overwrite the current panel.
- **LSP code intelligence** (ADR-0102): the bridge runs allowlisted, operator-installed
  language servers (rust-analyzer, typescript-language-server, csharp-ls) as supervised
  long-lived subprocesses and proxies their LSP JSON-RPC to the editor for project-aware
  completions, hover, go-to-definition, references, and diagnostics. An absent server
  degrades silently to the built-in in-file IntelliSense. The proxy is a URI-validating
  gateway, never a dumb pipe (ADR-0102 D-G): every file URI in every frame, both directions,
  must resolve inside an allowlisted workspace root (out-of-root client frames are refused;
  out-of-root locations and watch registrations from the server are filtered out;
  server-initiated `applyEdit` is denied outright with `applied: false` (edits reach the
  editor only as responses to operator-initiated requests, land in buffers, and persist
  only through the `write_file` save path); an out-of-root or non-file showDocument is
  refused), and
  command-bearing LSP methods are denied by default
  (`workspace/executeCommand` refused, command payloads stripped from code actions and
  code lenses). LSP configuration is host-owned too: client `initializationOptions` are
  stripped, `workspace/didChangeConfiguration` is refused, and the host itself answers a
  server's `workspace/configuration` request (settings can carry tool paths and override
  commands, so an opaque passthrough would be an execution surface). Every server spawn
  and denial is audit-logged on the host console, and all servers are retired when the
  last cockpit disconnects.

- **Cost before and after**: the run screen now shows a cost hint before you send (flat-plan
  models show "included"; metered/API models show a floor estimate plus your recent typical/high
  spend for that model), and every reply keeps reporting what it actually cost with the existing
  exact/derived/estimated fidelity markers. Rates are never hard-coded: the optional
  `HONEYHUB_MODEL_RATES` env var is the only rate source, and models without a rate show
  token counts instead of invented dollars.
- **Group checks are named checks**: the cockpit no longer sends command lines over the wire.
  You pick a named check per repo (`npm-test`, `cargo-test`, `dotnet-test`, ...) and the bridge
  host resolves it against its own built-in table (operator-overridable via
  `HONEYHUB_EXTRA_CHECKS`; extra-only ids are host-runnable but not yet offered by the
  cockpit picker); anything else is refused. Check runs are supervised (own process
  group, capped output capture, `HONEYHUB_CHECK_TIMEOUT_SECS` wall clock with a full
  process-tree kill) and each spawn is logged on the host. Wire: `run_check` now carries a
  check id; `check_result` reports the executed command, a disposition
  (ran/denied/spawn-failed/timed-out), a typed denial reason
  (overlap/unknown-check/task-failed), and truncation.
- **Chat dock**: the right-hand chat sidebar is THE desktop chat surface (the Chat page remains
  on small screens only) and is resizable by dragging its left edge or focusing the divider and
  using the arrow keys; the width is clamped and persisted.
- **Chat threads**: past conversations are now manageable threads. Search them by name or task
  text, rename them (the original task stays searchable), pin favorites to the top (pinned
  threads also survive the 100-chat history cap), and delete with a two-click confirm. A
  rename or pin set on a thread survives later saves from a live run.
- **Threads across devices**: the bridge-backed session history gets the same treatment. One
  search box covers both lists ("This device" and "All devices"); renaming, pinning, and
  deleting a synced thread happens on the bridge host's store, so every paired device sees
  the change. A pinned synced thread also keeps its transcript out of retention pruning.
  Wire: additive `rename_session` / `delete_session` / `pin_session` commands, each answered
  with a refreshed `session_list`; `DispatchSession` gains a `pinned` flag.
- The composer's routing/cost note is one compact line now (lead clause + cost hint,
  ellipsized); hover it for the full rationale and rate provenance.
- **Jobs page**: centered on YOUR jobs (your probe patterns and agent-related scheduled tasks)
  with a local start/stop history per job; the curated built-in rows and the raw process table
  moved behind a Diagnostics toggle.
- **Repo discovery**: workspace roots are now walked recursively (bounded depth, noise folders
  like `node_modules`/`target` skipped, no descent into a found repo), so repos nested in
  subfolders are found.
- Models: Claude Fable 5 joins the Claude picker (marked as usage-metered); model pricing/
  metering now travels on the catalog wire shape.

## [0.21.0] - 2026-06-22

Key Vault **expiry notifications** (the connector's third slice): get alerted when a secret, key, or
certificate in your selected subscriptions is approaching its expiry. (Versions: npm + this
changelog at 0.21.0; the Rust crate workspace at 0.27.0.)

- **Expiry alerts**: the notification engine background-scans your enabled Key Vault subscriptions
  for objects that carry an expiry, and fires an Alerts-feed entry (plus an OS toast) when one is
  within your window or already expired. Each item alerts once and is remembered across sessions.
- **Settings**: a new "Key Vault secret expiring" toggle and an "Alert when expiring within N days"
  field (default 30) under Settings, Notifications.
- The scan runs on a long cadence (expiry changes slowly, and it is a heavier `az` fan-out) and only
  while the connector is on with subscriptions selected.
- Internal: bridge `scan_expiring` aggregates the objects-with-expiry across vaults (the UI owns the
  clock and the threshold); additive `ScanKeyVaultExpiry` / `KeyVaultExpiry` wire calls.

## [0.20.0] - 2026-06-22

The **Azure Key Vault** connector's second slice: expand a vault to browse its contents and view a
secret. Read-only, still riding your host `az` sign-in. (Versions: npm + this changelog at 0.20.0;
the Rust crate workspace at 0.26.0.)

- **Browse a vault**: expand any vault to see its **secrets, keys, and certificates** (metadata
  only, never values), with a name/kind filter. Each row shows whether it is enabled and an
  **expiry badge** (amber within 30 days, red once expired). Per-kind best-effort: a kind you cannot
  read is skipped rather than failing the whole vault.
- **Reveal a secret**: a gated **Reveal** action fetches one secret's value on demand via
  `az keyvault secret show`. The value lives only in the open session (never logged or persisted)
  and clears on Hide. Vault and secret names are shape-validated before they ride the `az` command
  line.
- Internal: the Key Vault panel moved into its own `KeyVaultPanel` component; the connector adds
  `ListVaultObjects` / `RevealSecret` wire calls (additive).

## [0.19.0] - 2026-06-22

A new opt-in **Azure Key Vault** observability connector (read-only, first slice). Like the other
Azure connectors it rides your existing `az` sign-in on the bridge host, so the cockpit (desktop or
paired phone) never holds an Azure credential of its own. (Version tracks: npm + this changelog at
0.19.0; the Rust crate workspace at 0.25.0; the Tauri app build stays on its own track.)

- **Key Vault connector**: turn it on in Settings, Connectors, then in **Observe** pick which of
  your Azure subscriptions to look at and see their Key Vaults (name, resource group, location)
  with name/group/location filtering. Management plane only for now; browsing secret, key, and
  certificate metadata plus expiry alerts ride the same `az` path in the next slices.
- Internal: a shared `azcli` helper now backs both the Service Bus and Key Vault connectors
  (running `az` on the host and sanitizing its errors so subscription ids/paths never leak).

## [0.18.0] - 2026-06-21

A large control-hub expansion driven by operator dogfooding: a docked chat sidebar with
attachments, a full multi-repo Git client, a Service Bus connections explorer, desktop
notifications, themes, and desktop auto-update. (Version tracks: this changelog and the npm
packages share the 0.18.0 user-facing version; the Rust crate workspace is at 0.24.0 and the
Tauri app build at 0.23.0, each on its own internal track.)

- **Chat everywhere**: the floating quick-chat dock is now a collapsible right **sidebar** that
  renders the full chat (session history, model/provider picker, new chat, slash menu, agents)
  on every page. Both the Chat page and the sidebar accept **document uploads and pasted/dropped
  images**, materialized to a temp dir by the bridge and referenced by path (works across all
  backends).
- **Default workspace**: pick a default repo/folder (a star in the workspace picker) that is
  pre-selected across Chat, Git, and Browse, changeable anytime.
- **Multi-repo Git client**: select a folder and every repo inside it shows its branch,
  ahead/behind, and change count. Per repo: stage/unstage, commit, push, pull, switch/create/
  delete branches, discard (per-file + all), and quick diffs. All writes are confirmation-gated.
- **Live updates**: a filesystem watcher pushes change events so Browse + Git refresh near
  instantly (with a live indicator); Browse gained a changed-files panel grouped by repo, with
  inline diffs.
- **Service Bus connections**: save namespaces (Azure AD) or SAS connection strings (cockpit-held,
  never persisted host-side), open several at once, browse entities, peek/send/receive/purge/
  resubmit, and **manage** queues/topics/subscriptions (create/delete/edit properties) via a
  .NET admin-client helper. Connection strings ride per-request only.
- **Notifications**: OS toasts + an in-app Alerts feed (with unread badge) for a chat finishing
  while you are away, work assigned to you, mentions, PR review requests, and new dead-letters
  (GitHub + Azure DevOps where the APIs allow). Per-type toggles in Settings; opening Alerts
  marks them read.
- **Themes**: a Settings theme picker — Honey Cyberpunk (default), Midnight, Matrix, Daylight —
  applied via CSS variables and persisted.
- **Number stepper**: native number spinners replaced with a themed `− value +` control.
- **Desktop auto-update**: the Tauri shell checks a signed release manifest on launch and offers
  to install + relaunch; a tagged `release` workflow builds, signs, and publishes per-OS bundles
  (see `crates/desktop/RELEASING.md` for the one-time signing-key setup).

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
