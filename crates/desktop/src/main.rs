//! HoneyHub desktop shell.
//!
//! A single-process Tauri app: the bridge runtime + cockpit host run **in-process**
//! (no sidecar binary), and a native window points at the in-process server. On
//! start it binds an ephemeral loopback port, serves the built PWA + the
//! `honeyhub.bridge.v1` WebSocket on it, mints a pairing token, and opens the
//! cockpit at `http://127.0.0.1:<port>/?token=<token>` — so the same browser
//! cockpit runs as a desktop app with zero extra steps (ADR-0091 D2, §3f desktop
//! shell). Mobile reaches the same host over a tailnet later.
//!
//! Configuration mirrors the standalone host's environment variables:
//! - `HONEYHUB_WORKSPACE_ROOTS`: comma-separated absolute roots to allowlist.
//! - `HONEYHUB_CLAUDE_PROGRAM` / `HONEYHUB_CLAUDE_MODEL`: the Claude Code CLI.
//! - `HONEYHUB_GLOBAL_AGENTS`: opt in to user-global agent discovery.
//! - `HONEYHUB_STATIC_DIR`: override the served PWA directory (defaults to the
//!   workspace `packages/ui/dist`, resolved relative to this crate for dev).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::path::PathBuf;

use honeyhub_bridge::adapters::{default_event_clock, ClaudeLocalAdapter, CodexLocalAdapter};
use honeyhub_bridge::{
    clock, user_home, AgentBackend, BackendAllowlist, BridgeIdentity, BridgeRuntime, LocalStore,
    PairingRegistry, WorkspaceAllowlist,
};
use honeyhub_bridge_host::{bind, serve, DEFAULT_POLL_INTERVAL};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (url, _bound) = start_bridge()?;
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse()?),
            )
            .title("HoneyHub")
            .inner_size(1280.0, 860.0)
            .min_inner_size(960.0, 640.0)
            .build()?;
            // Best-effort self-update check on launch (no-op until the updater endpoint +
            // public key are configured; see tauri.conf.json + .github/workflows/release.yml).
            check_for_update(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HoneyHub desktop");
}

/// Check the release manifest for a newer signed build; if one exists, ask the user, then
/// download + verify + install and relaunch. Entirely best-effort: a missing/placeholder
/// updater config, no network, or a failed check just means "no update right now" — it must
/// never break the app. Only the native shell runs this; the served PWA updates via its assets.
fn check_for_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else {
            return;
        };
        let update = match updater.check().await {
            Ok(Some(update)) => update,
            _ => return,
        };
        let version = update.version.clone();
        let restart_app = app.clone();
        app.dialog()
            .message(format!(
                "HoneyHub {version} is available. Install it now? The app will restart."
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install & restart".to_string(),
                "Later".to_string(),
            ))
            .show(move |install| {
                if !install {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    if update
                        .download_and_install(|_chunk, _total| {}, || {})
                        .await
                        .is_ok()
                    {
                        restart_app.restart();
                    }
                });
            });
    });
}

/// Build the bridge runtime, bind an ephemeral loopback port, spawn the cockpit
/// host on the Tauri async runtime, and return the cockpit URL (with token) plus
/// the bound address. The runtime construction mirrors the standalone bridge host.
fn start_bridge() -> Result<(String, SocketAddr), Box<dyn std::error::Error>> {
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

    let program = std::env::var("HONEYHUB_CLAUDE_PROGRAM").unwrap_or_else(|_| "claude".to_string());
    let model = std::env::var("HONEYHUB_CLAUDE_MODEL").ok();
    let claude = ClaudeLocalAdapter::new(program, model, default_event_clock());

    let codex_program =
        std::env::var("HONEYHUB_CODEX_PROGRAM").unwrap_or_else(|_| "codex".to_string());
    let codex = CodexLocalAdapter::new(codex_program, default_event_clock());

    let mut runtime =
        BridgeRuntime::new(claude, workspace_allowlist, backend_allowlist).with_adapter(codex);
    // Discover the user's global agents (`~/.claude/agents`, `~/.copilot/agents`) by
    // default — this is the user's own machine + cockpit, and an empty Agents tab is a
    // worse default than reading their own home config. Set HONEYHUB_GLOBAL_AGENTS to
    // 0/false/off to disable.
    let disable_global = matches!(
        std::env::var("HONEYHUB_GLOBAL_AGENTS").as_deref(),
        Ok("0") | Ok("false") | Ok("off")
    );
    if !disable_global {
        if let Some(home) = user_home() {
            runtime = runtime.with_global_home(Some(home));
        }
    }

    // Local-first durable history under HONEYHUB_STORE_DIR, else ~/.honeyhub/store.
    if let Some(store_dir) = store_dir() {
        if let Ok(store) = LocalStore::open(store_dir) {
            runtime = runtime.with_store(store);
        }
    }

    // Pairing: mint a token the cockpit presents on connect.
    let mut registry = PairingRegistry::new(BridgeIdentity::new("honeyhub-desktop"));
    let grant = registry.pair("local-cockpit", clock::now_rfc3339());
    let token = grant.token;

    let static_dir = resolve_static_dir();

    // Bind synchronously so the window URL can carry the real port, then serve on
    // the background runtime. Prefer a STABLE loopback port (overridable via
    // HONEYHUB_BRIDGE_ADDR) so the webview origin — and therefore its localStorage
    // (onboarding + provider prefs) — survives across launches. Fall back to an
    // ephemeral port only if the preferred one is already taken (e.g. a standalone
    // host on 8765), accepting that this session won't reuse persisted prefs.
    let preferred: SocketAddr = std::env::var("HONEYHUB_BRIDGE_ADDR")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8765)));
    let listener = match tauri::async_runtime::block_on(bind(preferred)) {
        Ok(listener) => listener,
        Err(_) => {
            let ephemeral: SocketAddr = "127.0.0.1:0".parse()?;
            tauri::async_runtime::block_on(bind(ephemeral))?
        }
    };
    let bound = listener.local_addr()?;

    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(
            listener,
            runtime,
            registry,
            DEFAULT_POLL_INTERVAL,
            static_dir,
        )
        .await
        {
            eprintln!("honeyhub-desktop: bridge host stopped: {error}");
        }
    });

    let url = format!("http://127.0.0.1:{}/?token={}", bound.port(), token);
    Ok((url, bound))
}

/// Resolve the local store directory: `HONEYHUB_STORE_DIR` if set, else
/// `<home>/.honeyhub/store`.
fn store_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HONEYHUB_STORE_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir.trim()));
        }
    }
    user_home().map(|home| home.join(".honeyhub").join("store"))
}

/// Resolve the built PWA directory: `HONEYHUB_STATIC_DIR` when it names a real
/// directory, else the workspace `packages/ui/dist` resolved relative to this
/// crate (so `tauri dev` works regardless of the invocation cwd).
fn resolve_static_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HONEYHUB_STATIC_DIR") {
        let path = PathBuf::from(dir.trim());
        if path.is_dir() {
            return Some(path);
        }
    }
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/ui/dist");
    bundled.is_dir().then_some(bundled)
}
