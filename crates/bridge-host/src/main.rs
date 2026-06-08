//! HoneyHub bridge host binary.
//!
//! Runs the local bridge and exposes it to the cockpit PWA over a localhost
//! WebSocket. Configuration is via environment variables so it is trivial to
//! launch for local dogfooding:
//!
//! - `HONEYHUB_BRIDGE_ADDR`: listen address (default `127.0.0.1:8765`).
//! - `HONEYHUB_WORKSPACE_ROOTS`: comma-separated absolute workspace roots to allowlist (the bridge refuses launches outside them).
//! - `HONEYHUB_CLAUDE_PROGRAM`: the Claude Code CLI program (default `claude`).
//! - `HONEYHUB_CLAUDE_MODEL`: optional model passed to the CLI.
//!
//! On start it generates a pairing token and prints the WebSocket URL (including
//! the token) for the PWA to connect with.

use std::net::SocketAddr;

use honeyhub_bridge::adapters::{default_event_clock, ClaudeLocalAdapter};
use honeyhub_bridge::{
    AgentBackend, BackendAllowlist, BridgeIdentity, BridgeRuntime, PairingRegistry,
    WorkspaceAllowlist,
};
use honeyhub_bridge_host::{bind, serve, DEFAULT_POLL_INTERVAL};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let addr: SocketAddr = std::env::var("HONEYHUB_BRIDGE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8765".to_string())
        .parse()
        .expect("HONEYHUB_BRIDGE_ADDR must be a valid socket address");

    let roots: Vec<String> = std::env::var("HONEYHUB_WORKSPACE_ROOTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(str::to_string)
        .collect();
    let workspace_allowlist = WorkspaceAllowlist::new(roots);

    let backend_allowlist = BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]);

    let program = std::env::var("HONEYHUB_CLAUDE_PROGRAM").unwrap_or_else(|_| "claude".to_string());
    let model = std::env::var("HONEYHUB_CLAUDE_MODEL").ok();
    let adapter = ClaudeLocalAdapter::new(program, model, default_event_clock());

    let runtime = BridgeRuntime::new(adapter, workspace_allowlist, backend_allowlist);

    // Pairing: issue a token the PWA presents on connect.
    let mut registry = PairingRegistry::new(BridgeIdentity::new("honeyhub-bridge-host"));
    let grant = registry.pair("local-cockpit", honeyhub_bridge::clock::now_rfc3339());
    let token = grant.token;

    let listener = bind(addr).await?;
    let bound = listener.local_addr()?;
    println!("HoneyHub bridge host listening on ws://{bound}");
    println!("Cockpit URL: ws://{bound}/?token={token}");
    if std::env::var("HONEYHUB_WORKSPACE_ROOTS")
        .unwrap_or_default()
        .is_empty()
    {
        eprintln!(
            "warning: HONEYHUB_WORKSPACE_ROOTS is empty — every launch will be refused until you allowlist a workspace root"
        );
    }

    serve(listener, runtime, registry, DEFAULT_POLL_INTERVAL).await
}
