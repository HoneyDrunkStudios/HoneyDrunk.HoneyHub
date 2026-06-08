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

The run screen talks to the bridge over a WebSocket. Start the bridge host, then
connect the PWA to it:

1. Install and authenticate the official **Claude Code CLI** locally (the bridge
   shells out to it under your own session; it never stores your auth).
2. Start the host, allowlisting the workspace you want to run against:

   ```powershell
   $env:HONEYHUB_WORKSPACE_ROOTS = "C:\path\to\your\repo"
   cargo run -p honeyhub-bridge-host
   ```

   It prints a cockpit URL, e.g. `ws://127.0.0.1:8765/?token=<token>`.
3. Run the PWA (`npm run dev -w @honeydrunk/honeyhub-ui`), paste that URL into the
   **Bridge URL** field in the toolbar, and click **Connect**. The run screen now
   drives a real `claude.local` session through the host.

The WebSocket transport is `[Provisional]` (ADR-0091 D5): the bundled-desktop Tauri
shell will host the bridge in-process, and mobile reaches the same host over a
Tailscale tailnet — both behind the same `WireClient` seam, no UI change.

## Architecture Context

Architecture context lives in `HoneyDrunk.Architecture/repos/HoneyDrunk.HoneyHub/`.
