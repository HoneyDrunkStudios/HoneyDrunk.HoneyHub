# HoneyDrunk.HoneyHub

This repo is the HoneyHub Agent Cockpit. It is a mixed TypeScript and Rust workspace.

## Context

- Architecture context: `C:\Users\tatte\source\repos\HoneyDrunkStudios\HoneyDrunk.Architecture\repos\HoneyDrunk.HoneyHub\overview.md`
- Standup class: `studios-typescript-native`
- Required PR checks: `PR / Node Workspace` and `PR / Rust Workspace` once the shared Actions TypeScript/Rust jobs are merged.

## Boundaries

- Do not add a code editor.
- Do not add a terminal.
- Do not store or proxy vendor subscription auth.
- Treat local transcripts, command lines, paths, and outputs as sensitive by default.
- Durable writes should surface as artifacts, branches, PRs, packets, drafts, or reports.

## Toolchain

Run Node and Rust checks when available:

```powershell
npm install
npm run build
npm test
npm run lint
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
