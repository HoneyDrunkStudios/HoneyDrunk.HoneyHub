# HoneyDrunk.HoneyHub

HoneyHub is the Agent Cockpit: a local-first PWA and desktop shell for starting, watching, interrupting, and governing local AI coding-agent sessions.

The repo is a mixed TypeScript and Rust workspace:

- `packages/ui` - shared React and Vite PWA.
- `packages/shell` - minimal Tauri-class desktop shell wrapper.
- `packages/shared-types` - session-contract TypeScript types.
- `crates/bridge` - Rust local runner bridge skeleton.

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

Run the PWA:

```powershell
npm run dev -w @honeydrunk/honeyhub-ui
```

## Architecture Context

Architecture context lives in `HoneyDrunk.Architecture/repos/HoneyDrunk.HoneyHub/`.
