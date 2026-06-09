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
//! - `HONEYHUB_GLOBAL_AGENTS`: set (to a non-empty value) to **opt in** to discovering
//!   user-global agents from `~/.claude/agents` / `~/.copilot/agents`. Off by default:
//!   that reads outside the workspace allowlist (the user's own home config), so it is
//!   only enabled when the operator explicitly asks for it.
//!
//! On start it generates a pairing token, prints the URL (with the token), and —
//! when serving the PWA — opens it in the default browser.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use honeyhub_bridge::adapters::{default_event_clock, ClaudeLocalAdapter};
use honeyhub_bridge::{
    user_home, AgentBackend, BackendAllowlist, BridgeIdentity, BridgeRuntime, PairingRegistry,
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

    let mut runtime = BridgeRuntime::new(adapter, workspace_allowlist, backend_allowlist);
    // Opt in to user-global agent discovery only when explicitly enabled (off by default;
    // it reads outside the workspace allowlist — the user's own home config).
    let scan_global =
        std::env::var_os("HONEYHUB_GLOBAL_AGENTS").is_some_and(|value| !value.is_empty());
    if scan_global {
        match user_home() {
            Some(home) => runtime = runtime.with_global_home(Some(home)),
            None => eprintln!(
                "warning: HONEYHUB_GLOBAL_AGENTS is set, but HOME/USERPROFILE is unset; user-global agent discovery remains disabled"
            ),
        }
    }

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
    // A wildcard bind (0.0.0.0 / ::) is not a loadable browser host, so the URL we
    // print/open uses loopback; a device on the tailnet uses the host's tailnet IP.
    let display_addr = if bound.ip().is_unspecified() {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), bound.port())
    } else {
        bound
    };
    if static_dir.is_some() {
        let cockpit_url = format!("http://{display_addr}/?token={token}");
        println!("HoneyHub cockpit ready — open: {cockpit_url}");
        if bound.ip().is_unspecified() {
            println!(
                "  (listening on all interfaces; from another device on your tailnet open http://<this-host-tailnet-ip>:{}/?token={token})",
                bound.port()
            );
        }
        // Open the cockpit in the default browser unless told not to (e.g. when
        // the host runs headless or behind a tailnet reached from another device).
        if std::env::var("HONEYHUB_NO_BROWSER").is_err() {
            let _ = open::that(&cockpit_url);
        }
    } else {
        println!(
            "HoneyHub bridge host listening; connect the PWA to ws://{display_addr}/ws?token={token}"
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
