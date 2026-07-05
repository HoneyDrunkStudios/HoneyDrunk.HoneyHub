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
//! - `HONEYHUB_DISPATCH`: set to `0`/`false`/`off` to disable cross-backend subagents
//!   (ADR-0098). On by default: the bridge hosts a localhost `dispatch_agent` MCP
//!   endpoint at `/mcp` and injects it into Claude launches.
//! - `HONEYHUB_DISPATCH_BACKENDS`: comma-separated backend ids a dispatch may target
//!   (e.g. `codex`). Defaults to the configured backends; can only narrow, never widen.
//! - `HONEYHUB_DISPATCH_CHILD_CAP`: max children one session may spawn (default 4).
//!
//! On start it generates a pairing token, prints the URL (with the token), and —
//! when serving the PWA — opens it in the default browser.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use honeyhub_bridge::adapters::{default_event_clock, ClaudeLocalAdapter, CodexLocalAdapter};
use honeyhub_bridge::{
    child_cap_from_env, dispatch_backends_from_env, user_home, AgentBackend, BackendAllowlist,
    BridgeIdentity, BridgeRuntime, DispatchGovernor, LocalStore, PairingRegistry,
    WorkspaceAllowlist,
};
use honeyhub_bridge_host::{bind, serve, DEFAULT_POLL_INTERVAL};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let addr: SocketAddr = std::env::var("HONEYHUB_BRIDGE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8765".to_string())
        .parse()
        .expect("HONEYHUB_BRIDGE_ADDR must be a valid socket address");

    // Bind first so the dispatch MCP endpoint (ADR-0098) can be built against the
    // actually-bound address before the Claude adapter is constructed (the adapter
    // injects that endpoint into launches).
    let listener = bind(addr).await?;
    let bound = listener.local_addr()?;
    // A wildcard bind (0.0.0.0 / ::) is not a loadable host, so loopback is what we
    // print/open and what the local CLIs reach the MCP endpoint on.
    let display_addr = if bound.ip().is_unspecified() {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), bound.port())
    } else {
        bound
    };

    let roots: Vec<String> = std::env::var("HONEYHUB_WORKSPACE_ROOTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(str::to_string)
        .collect();
    let workspace_allowlist = WorkspaceAllowlist::new(roots);

    let backend_allowlist =
        BackendAllowlist::new(vec![AgentBackend::ClaudeLocal, AgentBackend::CodexLocal]);

    // Cross-backend subagents (ADR-0098): host a localhost dispatch MCP endpoint and
    // let the Claude adapter inject it into launches so a chat can spawn parented
    // subagents. The dispatch allowlist defaults to the configured backends and can
    // only be narrowed (HONEYHUB_DISPATCH_BACKENDS); the per-session child cap comes
    // from HONEYHUB_DISPATCH_CHILD_CAP (default 4). Set HONEYHUB_DISPATCH=0 to disable
    // — the endpoint is then absent and launches carry no `dispatch_agent` tool.
    let dispatch_disabled = matches!(
        std::env::var("HONEYHUB_DISPATCH").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    );
    let dispatch = if dispatch_disabled {
        None
    } else {
        Some(Arc::new(DispatchGovernor::new(
            format!("http://{display_addr}/mcp"),
            dispatch_backends_from_env(backend_allowlist.backends()),
            child_cap_from_env(),
        )))
    };

    let program = std::env::var("HONEYHUB_CLAUDE_PROGRAM").unwrap_or_else(|_| "claude".to_string());
    let model = std::env::var("HONEYHUB_CLAUDE_MODEL").ok();
    // Inject the dispatch endpoint into every Claude launch (Claude-only this slice;
    // Codex/Copilot injection is a follow-up). Graceful when dispatch is None.
    let claude = ClaudeLocalAdapter::new(program, model, default_event_clock())
        .with_dispatch(dispatch.clone());

    let codex_program =
        std::env::var("HONEYHUB_CODEX_PROGRAM").unwrap_or_else(|_| "codex".to_string());
    // Operator-owned model rates (HONEYHUB_MODEL_RATES) turn exact token counts into
    // derived USD figures; without the table, Codex costs stay honestly absent.
    let codex = CodexLocalAdapter::with_env_rates(codex_program, default_event_clock());

    let mut runtime =
        BridgeRuntime::new(claude, workspace_allowlist, backend_allowlist).with_adapter(codex);
    // Discover the user's global agents (`~/.claude/agents`, `~/.copilot/agents`) by
    // default; set HONEYHUB_GLOBAL_AGENTS=0/false/off to disable.
    let disable_global = matches!(
        std::env::var("HONEYHUB_GLOBAL_AGENTS").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    );
    if !disable_global {
        if let Some(home) = user_home() {
            runtime = runtime.with_global_home(Some(home));
        }
    }

    // Local-first durable history: persist sessions/runs/transcripts under the store dir
    // (HONEYHUB_STORE_DIR, else ~/.honeyhub/store). Best-effort: if it can't open, the
    // cockpit still works in-session, just without cross-restart history.
    if let Some(store_dir) = store_dir() {
        if let Ok(store) = LocalStore::open(store_dir) {
            runtime = runtime.with_store(store);
        }
    }

    // Pairing: issue a token the PWA presents on connect.
    let mut registry = PairingRegistry::new(BridgeIdentity::new("honeyhub-bridge-host"));
    let grant = registry.pair("local-cockpit", honeyhub_bridge::clock::now_rfc3339());
    let token = grant.token;

    // Serve the built PWA from HONEYHUB_STATIC_DIR, or packages/ui/dist if it
    // exists, so the whole cockpit runs from one command on one origin.
    let static_dir = resolve_static_dir();

    // The listener was bound (and `display_addr` computed) up front so the dispatch
    // endpoint could be built against it; announce it now.
    announce_endpoint(static_dir.is_some(), display_addr, bound, &token);
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
        dispatch,
    )
    .await
}

/// Resolve the local store directory: `HONEYHUB_STORE_DIR` if set, else
/// `<home>/.honeyhub/store`. `None` only when neither is available.
fn store_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HONEYHUB_STORE_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir.trim()));
        }
    }
    user_home().map(|home| home.join(".honeyhub").join("store"))
}

/// Resolve the directory of the built PWA to serve: `HONEYHUB_STATIC_DIR` when it
/// names a real directory, else `packages/ui/dist` when it exists, else `None`
/// (WebSocket-only). A set-but-non-directory `HONEYHUB_STATIC_DIR` warns and falls
/// back to WebSocket-only.
fn resolve_static_dir() -> Option<PathBuf> {
    match std::env::var("HONEYHUB_STATIC_DIR") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir.trim());
            if path.is_dir() {
                return Some(path);
            }
            eprintln!(
                "warning: HONEYHUB_STATIC_DIR '{}' is not a directory; serving the WebSocket only",
                path.display()
            );
            None
        }
        _ => {
            let default_dir = PathBuf::from("packages/ui/dist");
            default_dir.is_dir().then_some(default_dir)
        }
    }
}

/// Print the connection endpoint and, when serving the PWA, open it in the default
/// browser (unless `HONEYHUB_NO_BROWSER` is set).
fn announce_endpoint(serving_pwa: bool, display_addr: SocketAddr, bound: SocketAddr, token: &str) {
    if !serving_pwa {
        println!(
            "HoneyHub bridge host listening; connect the PWA to ws://{display_addr}/ws?token={token}"
        );
        return;
    }

    let cockpit_url = format!("http://{display_addr}/?token={token}");
    println!("HoneyHub cockpit ready — open: {cockpit_url}");
    if bound.ip().is_unspecified() {
        println!(
            "  (listening on all interfaces; from another device on your tailnet open http://<this-host-tailnet-ip>:{}/?token={token})",
            bound.port()
        );
    }
    // Open the cockpit in the default browser unless told not to (e.g. when the host
    // runs headless or behind a tailnet reached from another device).
    if std::env::var("HONEYHUB_NO_BROWSER").is_err() {
        let _ = open::that(&cockpit_url);
    }
}
