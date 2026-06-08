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
//! - `HONEYHUB_STATIC_DIR`: directory of the built PWA to serve (default
//!   `packages/ui/dist` when it exists). When served, open the printed http URL
//!   and the cockpit auto-connects; otherwise only the WebSocket is exposed.
//! - `HONEYHUB_NO_BROWSER`: set to skip auto-opening the cockpit in a browser
//!   (e.g. headless, or reaching the host from another device over a tailnet).
//!
//! On start it generates a pairing token, prints the URL (with the token), and —
//! when serving the PWA — opens it in the default browser.

use std::net::SocketAddr;
use std::path::PathBuf;

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

    // Serve the built PWA from HONEYHUB_STATIC_DIR, or packages/ui/dist if it
    // exists, so the whole cockpit runs from one command on one origin.
    let static_dir: Option<PathBuf> = match std::env::var("HONEYHUB_STATIC_DIR") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir.trim());
            if path.is_dir() {
                Some(path)
            } else {
                eprintln!(
                    "warning: HONEYHUB_STATIC_DIR '{}' is not a directory; serving the WebSocket only",
                    path.display()
                );
                None
            }
        }
        _ => {
            let default_dir = PathBuf::from("packages/ui/dist");
            default_dir.is_dir().then_some(default_dir)
        }
    };

    let listener = bind(addr).await?;
    let bound = listener.local_addr()?;
    if static_dir.is_some() {
        let cockpit_url = format!("http://{bound}/?token={token}");
        println!("HoneyHub cockpit ready — open: {cockpit_url}");
        // Open the cockpit in the default browser unless told not to (e.g. when
        // the host runs headless or behind a tailnet reached from another device).
        if std::env::var("HONEYHUB_NO_BROWSER").is_err() {
            let _ = open::that(&cockpit_url);
        }
    } else {
        println!(
            "HoneyHub bridge host listening; connect the PWA to ws://{bound}/ws?token={token}"
        );
    }
    if std::env::var("HONEYHUB_WORKSPACE_ROOTS")
        .unwrap_or_default()
        .is_empty()
    {
        eprintln!(
            "warning: HONEYHUB_WORKSPACE_ROOTS is empty — every launch will be refused until you allowlist a workspace root"
        );
    }

    serve(
        listener,
        runtime,
        registry,
        DEFAULT_POLL_INTERVAL,
        static_dir,
    )
    .await
}
