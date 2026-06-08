# HoneyDrunk.HoneyHub

HoneyHub is the Agent Cockpit: a local-first PWA and desktop shell for starting, watching, interrupting, and governing local AI coding-agent sessions.

The repo is a mixed TypeScript and Rust workspace:

- `packages/ui` - shared React and Vite PWA (the cockpit run screen).
- `packages/shell` - minimal Tauri-class desktop shell wrapper.
- `packages/shared-types` - session-contract TypeScript types.
- `crates/bridge` - Rust local runner bridge (runtime, adapters, store, notifications).
- `crates/bridge-host` - the local WebSocket host that exposes the bridge to the PWA over the `honeyhub.bridge.v1` wire protocol.

HoneyHub drives vendor CLIs under the user's own local session. It does not hold subscription auth, does not provide a code editor, and does not provide a terminal.

## Local Development

Prerequisites:

- Node.js 22.12.0 or newer.
- npm 11 or newer.
- Rust stable with `cargo` and `clippy`.

Install and build:

```powershell
npm install
npm run build
npm test
npm run lint
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run the PWA (offline demo — drives a scripted mock session):

```powershell
npm run dev -w @honeydrunk/honeyhub-ui
```

## Driving a real Claude Code session

The bridge host serves the cockpit **and** the WebSocket on one local origin, so a
single command runs the whole thing:

1. Install and authenticate the official **Claude Code CLI** locally (the bridge
   shells out to it under your own session; it never stores your auth).
2. Build the PWA once so the host has something to serve:

   ```powershell
   npm run build -w @honeydrunk/honeyhub-ui
   ```

3. Start the host, allowlisting the workspace you want to run against:

   ```powershell
   $env:HONEYHUB_WORKSPACE_ROOTS = "C:\path\to\your\repo"
   cargo run -p honeyhub-bridge-host
   ```

   It prints, e.g., `HoneyHub cockpit ready — open: http://127.0.0.1:8765/?token=<token>`.
4. The cockpit opens in your browser and **auto-connects** to the bridge; start a
   `claude.local` session and drive it. (Set `HONEYHUB_NO_BROWSER=1` to skip the
   auto-open.)

### From your phone (Tailscale)

The same one binary serves mobile — no separate app (ADR-0091 D2). With the bridge
host and your phone on one Tailscale tailnet, bind to **this machine's Tailscale
IP** (not `0.0.0.0`, which would expose the bridge on your LAN/Wi-Fi too):

```powershell
$env:HONEYHUB_BRIDGE_ADDR = "100.x.y.z:8765"  # this machine's Tailscale IP
$env:HONEYHUB_NO_BROWSER = "1"                # the phone opens it, not this machine
$env:HONEYHUB_WORKSPACE_ROOTS = "C:\path\to\your\repo"
cargo run -p honeyhub-bridge-host
```

From the phone's browser open `http://100.x.y.z:8765/?token=<token>` (the token is
printed on start). The page auto-connects to the same bridge. The relay is
Tailscale's encrypted WireGuard mesh — HoneyHub runs no middlebox and holds no
vendor auth on the path (ADR-0091 D5 `[Firm]`).

For UI development you can instead run the PWA dev server
(`npm run dev -w @honeydrunk/honeyhub-ui`, served on `:5173`) and paste the host's
`ws://127.0.0.1:8765/ws?token=…` into the toolbar **Bridge URL** field; without a
host it stays on the offline mock.

The transport is `[Provisional]` (ADR-0091 D5): a bundled-desktop **Tauri** shell
can wrap this same local server in a native window, and mobile reaches it over a
**Tailscale** tailnet — both behind the same `WireClient` seam, no UI change.

## Architecture Context

Architecture context lives in `HoneyDrunk.Architecture/repos/HoneyDrunk.HoneyHub/`.
