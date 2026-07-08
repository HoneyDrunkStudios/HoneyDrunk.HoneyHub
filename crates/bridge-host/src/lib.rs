//! HoneyHub bridge host — serves the cockpit PWA and exposes a `BridgeRuntime` to
//! it over the `honeyhub.bridge.v1` wire protocol, on one local origin.
//!
//! This is the transport that connects the browser cockpit to the Rust bridge
//! (ADR-0091 D2/D5: the desktop shell hosts the bridge on localhost; mobile
//! reaches the same host over a Tailscale tailnet). It serves the built PWA as
//! static assets and upgrades `/ws` to a WebSocket, so the page and the socket
//! share an origin — the PWA derives the socket URL from its own location and
//! auto-connects. The transport mechanism is `[Provisional]` (ADR-0091 D5); a
//! Tauri shell can wrap this same local server in a native window unchanged.
//!
//! A client presents its pairing token (packet 05) as the `token` query parameter
//! on the WebSocket URL; an unknown/revoked token is rejected at the handshake.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use honeyhub_bridge::clock::now_rfc3339;
use honeyhub_bridge::{
    BridgeError, BridgeEvent, ClientCommand, DispatchGovernor, PairingRegistry, WireFrame,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::services::ServeDir;

/// The bridge-hosted MCP server exposing `dispatch_agent` (ADR-0098). Mounted at
/// `/mcp` on the same router as the WS wire when dispatch is enabled.
mod mcp;

/// Debounce window for coalescing a burst of filesystem events into one notification.
const FS_DEBOUNCE: Duration = Duration::from_millis(400);
/// Cap on paths carried in one `fs_changed` event, so a huge operation (e.g. a checkout
/// touching thousands of files) never floods the wire.
const FS_PATHS_CAP: usize = 64;

/// Default poll cadence for draining the runtime's event stream.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Cap on project launches a single connection may hold at once, so a buggy or hostile client
/// cannot spawn unbounded long-lived processes (ADR-0104 D2 supervised lifecycle).
const LAUNCH_MAX_PER_CONN: usize = 8;
/// Cap on relay launches a single connection may have parked awaiting confirmation, so an
/// unconfirmed-launch flood cannot grow the pending map without bound.
const PENDING_LAUNCH_MAX_PER_CONN: usize = 8;
/// A parked relay launch expires if not confirmed within this window (swept by the watchdog).
const PENDING_LAUNCH_TTL_MS: u64 = 5 * 60 * 1000;
/// How often the launch watchdog polls each launch for process exit.
const LAUNCH_EXIT_POLL: Duration = Duration::from_secs(1);
/// Cap on integrated terminals a single connection may hold open at once, so a buggy or
/// hostile client cannot spawn unbounded shells (ADR-0103 D5 supervised lifecycle).
const TERMINAL_MAX_PER_CONN: usize = 8;
/// Cap on one `terminal_input` frame's decoded byte length, so a giant paste can't wedge the
/// worker on a blocking PTY write while the terminals lock is held.
const TERMINAL_MAX_INPUT: usize = 256 * 1024;
/// Environment override (seconds) for the idle-timeout watchdog; `0` disables it. An idle
/// terminal (no input and no output) past this is retired (ADR-0103 D5).
const TERMINAL_IDLE_ENV: &str = "HONEYHUB_TERMINAL_IDLE_SECS";
/// Default terminal idle timeout: 30 minutes of no I/O.
const TERMINAL_IDLE_DEFAULT_SECS: u64 = 30 * 60;
/// How often the idle watchdog sweeps for expired terminals.
const TERMINAL_IDLE_SWEEP: Duration = Duration::from_secs(60);

/// Shared host state: the runtime (single-writer behind an async mutex), the set
/// of runs still worth polling, and a broadcast of events to every client.
struct Host {
    runtime: Mutex<honeyhub_bridge::BridgeRuntime>,
    active_runs: Mutex<std::collections::HashSet<String>>,
    /// Roots with a group check currently in flight — overlapping requests for the
    /// same root are refused so repeated clicks can't stack subprocesses.
    active_checks: Mutex<std::collections::HashSet<String>>,
    /// Backends with a usage probe in flight (single-flight: each probe boots a full
    /// vendor TUI, so repeated clicks or multiple cockpits must not stack them).
    active_probes: Mutex<std::collections::HashSet<String>>,
    /// Live language servers, one per (canonical root, language) — long-lived supervised
    /// subprocesses reused across files, killed on stop / root-removal / last-client
    /// disconnect / shutdown (ADR-0102 D-C).
    active_lsp: Mutex<LspState>,
    /// Connected WebSocket clients. When the LAST one disconnects, every running language
    /// server is retired (ADR-0102 D-C: a server never outlives the cockpit it serves);
    /// a second paired device keeps them alive.
    connected_clients: std::sync::atomic::AtomicUsize,
    events: broadcast::Sender<BridgeEvent>,
    /// The live filesystem watcher (the recommended OS-native backend) plus the roots it is
    /// currently watching. Re-pointed whenever the workspace allowlist changes. `None` until
    /// the watcher is installed in `serve`, or if the platform watcher could not start.
    watcher: Mutex<Option<(RecommendedWatcher, Vec<String>)>>,
    /// The cross-backend dispatch governor (ADR-0098), when dispatch is enabled. Held so the
    /// poll loop can **revoke** a run's per-run capability token the moment the run reaches a
    /// terminal state, so a token cannot outlive the parent run it was minted for.
    dispatch: Option<Arc<DispatchGovernor>>,
    /// Live project launches plus the allowlisted-roots snapshot they are authorized against,
    /// behind ONE mutex (ADR-0104 D2). Keeping the roots snapshot inside the same lock that guards
    /// the launch map makes a launch's root-authorization check atomic with its registration: a
    /// concurrent `SetWorkspaceRoots` cannot slip a launch into a just-removed root (the
    /// atomic-revocation pattern already used for LSP). Launch is mobile-safe (relay-reachable),
    /// so a relay connection may start one (D3).
    active_launches: Mutex<LaunchState>,
    /// Relay launches held awaiting the operator's confirmation (ADR-0104 D3): a relay
    /// `LaunchStart` does not spawn; it parks here keyed by a host `confirm_id` and spawns only on
    /// the matching `LaunchConfirm` from the same connection. Cleared on that connection's
    /// disconnect and swept for staleness.
    pending_launches: Mutex<HashMap<String, PendingLaunch>>,
    /// Live integrated-terminal sessions (ADR-0103), keyed by session id. Each is a PTY-backed
    /// shell owned by the connection that opened it (`conn_id`), tree-killed when that
    /// connection disconnects, when its opening root leaves the allowlist, on idle timeout, or
    /// on explicit close. Desktop-local-only: a relay connection is refused a terminal (D3).
    /// Live terminals plus the allowlisted-roots snapshot they are authorized against, behind
    /// ONE mutex (the atomic-revocation pattern, like `LspState`): a terminal's root-auth check
    /// and its registration are atomic against a concurrent `SetWorkspaceRoots`, so no shell can
    /// be registered into a just-removed root (ADR-0103 D5 firm root removal).
    active_terminals: Mutex<TerminalState>,
    /// Reaper channel: a terminal's output-pump thread posts its session id here when the
    /// shell exits (the PTY reached EOF) so a tokio task can drop the now-dead entry off the
    /// map (a std pump thread cannot take the async terminals lock itself).
    terminal_reaper: mpsc::UnboundedSender<String>,
    /// Live debug sessions (ADR-0106), keyed by session id, plus the allowlisted-roots snapshot
    /// they are authorized against, behind ONE mutex (the atomic-revocation pattern). Each is a
    /// supervised debug adapter owned by the connection that opened it (`conn_id`), tree-killed
    /// with its debuggee on close / disconnect / token-revocation / opening-root-removal (D6).
    /// Desktop-local-only: a relay connection is refused a debug session by default (D5).
    active_dap: Mutex<DapState>,
    /// Reaper channel: a debug adapter's message-pump thread posts its session id here when the
    /// adapter exits (its stdout reached EOF) so a tokio task can retire the now-dead session
    /// off the map (a std pump thread cannot take the async `active_dap` lock itself).
    dap_reaper: mpsc::UnboundedSender<String>,
    /// Monotonic source of per-connection ids, so a launch (or terminal) can be tied to the
    /// socket that opened it and swept when that socket disconnects.
    next_conn_id: AtomicU64,
}

/// The live debug sessions plus the roots snapshot they are validated against, behind one mutex
/// so a session's authorization check and its registration are atomic against root removal
/// (ADR-0106 D6, the atomic-revocation pattern used for LSP / launch / terminal).
#[derive(Default)]
struct DapState {
    sessions: HashMap<String, DapEntry>,
    roots: honeyhub_bridge::WorkspaceAllowlist,
}

/// One live debug session and the bookkeeping to supervise it (ADR-0106 D6). netcoredbg is
/// launch-with-debugger: the adapter spawns the debuggee as its OWN child, so the debuggee sits
/// in the adapter's process group and the adapter's tree-kill takes it too (no separate handle
/// for Slice A; launch-then-attach for node is Slice C).
struct DapEntry {
    /// The supervised debug adapter. Dropping it tree-kills the adapter AND the debuggee it
    /// launched (shared process group).
    adapter: honeyhub_bridge::dap::DapAdapter,
    /// The canonical allowlisted workspace root, re-checked on a workspace-root change so a
    /// session whose root is removed is retired, and the `launch`-request gate forces the
    /// debuggee's cwd to it (D3 / D6).
    root: String,
    /// The connection that owns this session (ADR-0106 D6: bound to the opening paired device).
    /// Only the owner may drive it (`dap_send` is owner-checked by `conn_id`) or stop it; its
    /// `dap_message` frames are delivered only to the owner's sink (held by the pump thread, since
    /// runtime memory is potentially secret, D7 / D9), while open/close go device-wide.
    conn_id: u64,
    /// Unix-millis of the last DAP frame in either direction, for the idle-timeout watchdog
    /// (ADR-0106 D6). An `Arc` so the pump thread can stamp inbound activity lock-free.
    last_activity: Arc<AtomicU64>,
}

/// The live launches plus the roots snapshot they are validated against, behind one mutex so a
/// launch's authorization check and its registration are atomic against root removal.
#[derive(Default)]
struct LaunchState {
    launches: HashMap<String, LaunchEntry>,
    roots: honeyhub_bridge::WorkspaceAllowlist,
}

/// A relay launch held awaiting the operator's confirmation (ADR-0104 D3).
struct PendingLaunch {
    /// The canonical allowlisted project root (gated at request time; re-checked atomically at spawn).
    root: String,
    /// The detected target id the operator will confirm; the host re-resolves it to an argv at spawn.
    target_id: String,
    /// The connection that requested it; only that connection may confirm (and the confirming
    /// connection's own outbound sink is used at spawn, so the parked entry holds no sender).
    conn_id: u64,
    /// The client's correlation nonce, echoed on the eventual `LaunchStarted`.
    open_id: Option<String>,
    /// Unix-millis when parked, for the staleness sweep.
    created_at: u64,
}

/// One live project launch and the bookkeeping to supervise it (ADR-0104 D2).
struct LaunchEntry {
    /// The supervised child. Dropping it tree-kills the process group.
    session: honeyhub_bridge::launch::LaunchSession,
    /// The canonical allowlisted project root, re-checked on a workspace-root change so a launch
    /// whose root is removed is retired (D2).
    root: String,
    /// The connection that owns this launch (swept on that connection's disconnect).
    conn_id: u64,
    /// The owning connection's outbound sink. Every event for this launch (started/output/stopped)
    /// is routed here so raw process output never reaches another device (ADR-0104 D2, D11).
    owner: mpsc::Sender<WireFrame>,
}

/// The live terminals plus the roots snapshot they are validated against, behind one mutex so a
/// terminal's authorization check and its registration are atomic against root removal.
#[derive(Default)]
struct TerminalState {
    terminals: HashMap<String, TerminalEntry>,
    roots: honeyhub_bridge::WorkspaceAllowlist,
}

/// One live integrated-terminal session and the bookkeeping to supervise it (ADR-0103 D5).
struct TerminalEntry {
    /// The PTY-backed shell. Dropping it tree-kills the shell and its descendants and joins
    /// the reader thread, so every retire path is just a map removal + drop.
    session: honeyhub_bridge::terminal::TerminalSession,
    /// The canonical allowlisted root the shell was opened in, re-checked on a workspace-root
    /// change so a session whose root is removed is retired (D2/D5).
    root: String,
    /// The connection that owns this session. ADR-0103 D1: a terminal is bound to the connection
    /// that opened it. Only the owner may drive it (input/resize/close are owner-checked) and its
    /// output is delivered ONLY to the owner (via `owner` below), never broadcast to other local
    /// cockpits. Swept on that connection's disconnect.
    conn_id: u64,
    /// The owning connection's outbound frame sink. Every event for this session (opened /
    /// output / closed) is routed here, so a second local cockpit that learned the session id
    /// cannot observe another operator's shell.
    owner: mpsc::Sender<WireFrame>,
    /// Unix-millis of the last input or output, for the idle-timeout watchdog. An `Arc` so the
    /// output pump thread can stamp it lock-free.
    last_activity: Arc<AtomicU64>,
    /// Set true by whichever path emits this session's single `terminal_closed` event (the
    /// pump on shell exit, or a retire path), so the close is announced exactly once.
    closed: Arc<std::sync::atomic::AtomicBool>,
}

/// The running language servers plus the allowlisted-roots snapshot they are validated
/// against, behind ONE mutex so a frame's root-authorization check and the server
/// write/broadcast are atomic with respect to root removal (ADR-0102 firm workspace-root
/// removal). `SetWorkspaceRoots` updates `roots` and sweeps orphaned `servers` under this
/// same lock, so no LSP path can observe "new roots but a still-registered server for a
/// now-removed root" and slip a frame through. Kept OFF the runtime lock so a per-keystroke
/// completion never queues behind a backend run.
#[derive(Default)]
struct LspState {
    servers: HashMap<LspKey, honeyhub_bridge::LspServer>,
    roots: honeyhub_bridge::WorkspaceAllowlist,
    /// The in-flight `initialize` request id for a (root, language), set when the FIRST
    /// cockpit's initialize is forwarded and cleared when its result returns. LSP allows
    /// exactly one `initialize` per server, so a shared server must be initialized once.
    pending_init: HashMap<LspKey, serde_json::Value>,
    /// Request ids of later cockpits whose `initialize` arrived while the first was still
    /// in flight (not yet cached). They are NOT forwarded (that would double-initialize the
    /// shared server); instead they are coalesced here and answered the moment the first
    /// initialize result caches.
    init_waiters: HashMap<LspKey, Vec<serde_json::Value>>,
    /// The cached `InitializeResult` for a running server. A later cockpit's `initialize`
    /// is answered from this (host-owned initialization) rather than forwarded, so the
    /// shared server never sees a duplicate initialize and the later cockpit still gets
    /// the real capabilities.
    init_results: HashMap<LspKey, serde_json::Value>,
}

/// What the host does with a client `initialize` (host-owned initialization: exactly one
/// initialize reaches a shared server).
#[derive(Debug, PartialEq, Eq)]
enum InitDecision {
    /// The first initialize: forward it to the server (its id is now recorded as pending).
    Forward,
    /// Answer this caller from the cached `InitializeResult` (carried), do not forward.
    ReplyCached(serde_json::Value),
    /// A first initialize is still in flight: this caller is coalesced (queued if it had an
    /// id) and will be answered when the result caches; do not forward.
    Coalesced,
}

impl LspState {
    /// Remove a server and its initialize tracking for `key` (used by every retire path so
    /// a later restart re-initializes cleanly).
    fn take_server(&mut self, key: &LspKey) -> Option<honeyhub_bridge::LspServer> {
        self.pending_init.remove(key);
        self.init_waiters.remove(key);
        self.init_results.remove(key);
        self.servers.remove(key)
    }

    /// Decide what to do with a client `initialize` for `key`, recording pending/waiter
    /// state as a side effect. Guarantees exactly one initialize is forwarded to a shared
    /// server: the first forwards; one arriving while that is in flight is coalesced; one
    /// arriving after the result caches is answered from the cache.
    fn on_initialize(
        &mut self,
        key: &LspKey,
        request_id: Option<serde_json::Value>,
    ) -> InitDecision {
        if let Some(cached) = self.init_results.get(key) {
            return InitDecision::ReplyCached(cached.clone());
        }
        if self.pending_init.contains_key(key) {
            if let Some(id) = request_id {
                self.init_waiters.entry(key.clone()).or_default().push(id);
            }
            return InitDecision::Coalesced;
        }
        if let Some(id) = request_id {
            self.pending_init.insert(key.clone(), id);
        }
        InitDecision::Forward
    }
}

/// Identity of a language server: its workspace root (canonicalized so two spellings of
/// the same tree share one server) and the language it serves.
#[derive(Clone, PartialEq, Eq, Hash)]
struct LspKey {
    root: String,
    language_id: String,
}

impl LspKey {
    fn new(root: &str, language_id: &str) -> Self {
        // Canonicalize the root so "C:/work" and "C:\work\." key the same server; fall back
        // to the raw string when the path can't be canonicalized (matches `spawn_check`).
        let root = std::fs::canonicalize(root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.to_string());
        Self {
            root,
            language_id: language_id.to_string(),
        }
    }
}

struct AppState {
    host: Arc<Host>,
    registry: Arc<PairingRegistry>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            host: Arc::clone(&self.host),
            registry: Arc::clone(&self.registry),
        }
    }
}

/// Bind a listener for the host. Returns the listener so callers (and tests) can
/// read the actually-bound address before serving.
pub async fn bind(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr).await
}

/// Serve the cockpit and bridge over the given listener. `static_dir`, when set,
/// is served as the PWA at `/` (the WebSocket lives at `/ws`); when `None`, only
/// the WebSocket is served.
pub async fn serve(
    listener: TcpListener,
    runtime: honeyhub_bridge::BridgeRuntime,
    registry: PairingRegistry,
    poll_interval: Duration,
    static_dir: Option<PathBuf>,
    dispatch: Option<Arc<DispatchGovernor>>,
) -> std::io::Result<()> {
    // The address we actually bound. Whether it is loopback decides if the dispatch MCP
    // endpoint may be served at all (ADR-0098 B — localhost only).
    let bound = listener.local_addr()?;
    let (events_tx, _events_rx) = broadcast::channel::<BridgeEvent>(1024);
    // Seed the LSP roots snapshot from the runtime's initial allowlist, so LSP forwarding
    // is authorized against the real roots before the first SetWorkspaceRoots (which then
    // keeps the snapshot in sync under the active_lsp lock).
    let initial_roots = runtime.workspace_roots();
    let initial_lsp = LspState {
        roots: honeyhub_bridge::WorkspaceAllowlist::new(initial_roots.clone()),
        ..LspState::default()
    };
    let initial_launches = LaunchState {
        roots: honeyhub_bridge::WorkspaceAllowlist::new(initial_roots.clone()),
        ..LaunchState::default()
    };
    let initial_terminals = TerminalState {
        roots: honeyhub_bridge::WorkspaceAllowlist::new(initial_roots.clone()),
        ..TerminalState::default()
    };
    let initial_dap = DapState {
        roots: honeyhub_bridge::WorkspaceAllowlist::new(initial_roots),
        ..DapState::default()
    };
    let (terminal_reaper, mut terminal_reaped) = mpsc::unbounded_channel::<String>();
    let (dap_reaper, mut dap_reaped) = mpsc::unbounded_channel::<String>();
    let host = Arc::new(Host {
        runtime: Mutex::new(runtime),
        active_runs: Mutex::new(std::collections::HashSet::new()),
        active_checks: Mutex::new(std::collections::HashSet::new()),
        active_probes: Mutex::new(std::collections::HashSet::new()),
        active_lsp: Mutex::new(initial_lsp),
        connected_clients: std::sync::atomic::AtomicUsize::new(0),
        events: events_tx,
        watcher: Mutex::new(None),
        dispatch: dispatch.clone(),
        active_launches: Mutex::new(initial_launches),
        pending_launches: Mutex::new(HashMap::new()),
        active_terminals: Mutex::new(initial_terminals),
        terminal_reaper,
        active_dap: Mutex::new(initial_dap),
        dap_reaper,
        next_conn_id: AtomicU64::new(0),
    });

    // Debug-adapter reaper (ADR-0106 D6): when an adapter exits, its message-pump thread posts
    // the session id here; retire the dead session (announce its close once, tree-kill anything
    // left) off the async worker.
    {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            while let Some(session_id) = dap_reaped.recv().await {
                retire_dap(&host, &session_id, "adapter_exited").await;
            }
        });
    }

    {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(poll_interval);
            loop {
                ticker.tick().await;
                poll_active_runs(&host).await;
            }
        });
    }

    // Launch exit watchdog (ADR-0104 D2): poll each launch's process for exit. This detects a
    // finished launch by its PROCESS exiting, independent of its output pipes, so a launch whose
    // descendant still holds a pipe open is still reaped (and gives the real exit code the wire
    // reports). Retiring tree-kills, which also closes any pipe a lingering descendant held.
    {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(LAUNCH_EXIT_POLL);
            loop {
                ticker.tick().await;
                let exited: Vec<(String, Option<i32>)> = {
                    let mut state = host.active_launches.lock().await;
                    state
                        .launches
                        .iter_mut()
                        .filter_map(|(id, entry)| {
                            entry.session.poll_exit().map(|code| (id.clone(), code))
                        })
                        .collect()
                };
                for (launch_id, code) in exited {
                    retire_launch(&host, &launch_id, "exited", code).await;
                }
                // Expire relay launches parked awaiting confirmation past the TTL, so an
                // unconfirmed launch does not linger in the pending map indefinitely.
                let now = now_millis();
                host.pending_launches.lock().await.retain(|_, pending| {
                    now.saturating_sub(pending.created_at) < PENDING_LAUNCH_TTL_MS
                });
            }
        });
    }

    // Terminal reaper: when a shell exits, its pump thread posts the session id here; drop the
    // dead entry off the map on a blocking task (the Drop tree-kills; the reader/writer threads
    // are detached and already finishing). The pump already announced `terminal_closed`, so this
    // is a pure cleanup.
    {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            while let Some(session_id) = terminal_reaped.recv().await {
                let removed = host
                    .active_terminals
                    .lock()
                    .await
                    .terminals
                    .remove(&session_id);
                if let Some(entry) = removed {
                    tokio::task::spawn_blocking(move || drop(entry.session));
                }
            }
        });
    }

    // Terminal idle watchdog (ADR-0103 D5): retire any terminal with no input or output for
    // longer than the idle timeout. Disabled when the timeout is `0`.
    let idle_ms = terminal_idle_ms();
    if idle_ms > 0 {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(TERMINAL_IDLE_SWEEP);
            loop {
                ticker.tick().await;
                let now = now_millis();
                let expired: Vec<String> = {
                    let state = host.active_terminals.lock().await;
                    state
                        .terminals
                        .iter()
                        .filter(|(_, entry)| {
                            now.saturating_sub(entry.last_activity.load(Ordering::Relaxed))
                                > idle_ms
                        })
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                for session_id in expired {
                    retire_terminal(&host, &session_id, "idle_timeout").await;
                }
            }
        });
    }

    // Debug idle watchdog (ADR-0106 D6): retire any debug session with no DAP traffic in either
    // direction for longer than the idle timeout, so a connected cockpit cannot keep an adapter
    // (and its debuggee) alive indefinitely. Disabled when the timeout is `0`.
    let dap_idle_ms = dap_idle_ms();
    if dap_idle_ms > 0 {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(DAP_IDLE_SWEEP);
            loop {
                ticker.tick().await;
                let now = now_millis();
                let expired: Vec<String> = {
                    let state = host.active_dap.lock().await;
                    state
                        .sessions
                        .iter()
                        .filter(|(_, entry)| {
                            now.saturating_sub(entry.last_activity.load(Ordering::Relaxed))
                                > dap_idle_ms
                        })
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                for session_id in expired {
                    retire_dap(&host, &session_id, "idle_timeout").await;
                }
            }
        });
    }

    // Install the filesystem watcher so Browse + Git update near-instantly on disk changes
    // (debounced) instead of polling.
    install_fs_watcher(&host).await;

    let mut app = Router::new().route("/ws", get(ws_handler));
    // Mount the cross-backend dispatch MCP endpoint (ADR-0098) alongside the WS wire
    // on the same origin, when the host enabled it. `nest_service` at `/mcp` takes
    // precedence over the static fallback below. When dispatch is disabled the
    // endpoint is simply absent — launched CLIs then carry no `dispatch_agent` tool.
    //
    // Loopback-only (`[Firm]`, ADR-0098 B): the endpoint is served ONLY when the bridge is
    // bound to a loopback address. On a non-loopback bind (0.0.0.0 / a LAN or tailnet address)
    // the whole app is reachable off-box, so `/mcp` — a local exec-initiation surface — must
    // NOT be exposed there; it is suppressed rather than served to non-loopback origins. The
    // local child CLIs always reach the bridge over loopback, so a loopback bind keeps dispatch
    // fully working; only the off-box (tailnet) transport gives it up, which is the safe default.
    if let Some(governor) = dispatch {
        if bound.ip().is_loopback() {
            app = app.nest_service("/mcp", mcp::dispatch_service(Arc::clone(&host), governor));
        } else {
            eprintln!(
                "bridge-host: dispatch MCP endpoint suppressed — bound to non-loopback {bound}; \
                 /mcp is loopback-only (ADR-0098 B)"
            );
        }
    }
    let state = AppState {
        host,
        registry: Arc::new(registry),
    };
    if let Some(dir) = static_dir {
        app = app.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    }
    let app = app.with_state(state);

    // Carry the peer address into handlers (`ConnectInfo<SocketAddr>`) so the WS handshake can
    // classify a connection as desktop-local (loopback) or relay (off-box), which the launch
    // audit records (ADR-0104 D3/D7) and the cockpit uses to decide the relay confirmation.
    // classify a connection as desktop-local (loopback) or relay (off-box). The integrated
    // terminal is refused to relay connections (ADR-0103 D3), the same posture that gates the
    // dispatch `/mcp` endpoint above.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

async fn ws_handler(
    upgrade: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> Response {
    // axum URL-decodes query values, so the token matches the registry as issued.
    let authorized = params
        .get("token")
        .map(|token| state.registry.is_authorized(token))
        .unwrap_or(false);
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "invalid pairing token").into_response();
    }
    // Revocation posture (ADR-0103 D5 / ADR-0104 D2 / ADR-0106 D6 "killed on unpair"): the registry
    // is an immutable startup snapshot (`Arc<PairingRegistry>`) and v1 exposes NO live-revoke wire
    // command, so a device cannot be revoked while its socket is open. Unpairing is a config edit
    // that takes effect on the next bridge start, and a restart drops every socket, which the
    // disconnect sweep in `handle_socket` turns into a tree-kill of that connection's terminals,
    // launches, AND debug sessions (and the process death tree-kills them regardless). So the "kill
    // on unpair" guarantee holds transitively today. If a live-revoke command is ever added, bind
    // the resource entries to the owning device id here and add a device-keyed retirement sweep; the
    // teardown it would call (`kill_launch_entry` / terminal retirement / `retire_dap`) kills-first.
    // A loopback peer is the desktop shell's own cockpit (local); anything else reached the
    // bridge over the LAN / tailnet relay. This `local` flag is the gate a relay launch's
    // confirmation hangs on: a local launch spawns directly, a relay launch is parked awaiting
    // `LaunchConfirm` (ADR-0104 D3).
    //
    // Honest limitation (ADR-0090 D4): this trusts the transport peer address, which correctly
    // labels the supported relay topology (a Tailscale peer arrives with its 100.64/10 address, so
    // it is classified relay and gated). A peer reaching the bridge THROUGH a localhost-terminating
    // forwarder the operator deliberately set up (an `ssh -L` tunnel, a 127.0.0.1-bound reverse
    // proxy) presents as loopback and is treated local, spawning without the confirmation. That is
    // the operator choosing to expose a local surface, the same way port-forwarding exposes any
    // localhost service; a hardened remote-debug/-launch posture behind an explicit host opt-in is
    // the ADR-0104 D5 / ADR-0106 D5 follow-up, and this classifier does not claim to defeat it.
    // Revocation posture (ADR-0103 D5 "killed on unpair"): the registry is an immutable startup
    // snapshot (`Arc<PairingRegistry>`) and v1 exposes NO live-revoke wire command, so a device
    // cannot be revoked while its socket is open. Unpairing is a config edit that takes effect on
    // the next bridge start, and a restart drops every socket, which the disconnect sweep in
    // `handle_socket` turns into a tree-kill of that connection's terminals (and the shell dying
    // with the process tree kills them regardless). So the "kill on unpair" guarantee holds
    // transitively today. If a live-revoke command is ever added, bind each terminal entry to the
    // owning device id here and add a device-keyed retirement sweep; the teardown it would call
    // (`kill_terminal_entry`) already kills-first.
    // A loopback peer is the desktop shell's own cockpit (local); anything else reached the
    // bridge over the LAN / tailnet relay. Only local connections may open a terminal (D3), and
    // terminal events are dropped for non-local connections on egress (see the writer task).
    //
    // Honest limitation (ADR-0090 D4): this trusts the transport peer address. It correctly
    // denies the default relay topologies (a tailnet/LAN client arrives with its own address),
    // but a peer that reaches the bridge THROUGH a localhost-terminating tunnel the operator
    // deliberately set up (e.g. `tailscale serve` onto 127.0.0.1, or `ssh -L`) presents as
    // loopback and is treated as local. That is the operator choosing to expose a local surface,
    // the same way port-forwarding exposes any localhost service; we do not claim to defeat it.
    let local = peer.ip().is_loopback();
    upgrade.on_upgrade(move |socket| handle_socket(socket, state.host, local))
}

/// Directories whose churn is build/VCS noise rather than user edits: filesystem events anywhere
/// under one of these are dropped before debouncing, so generated output and VCS internals do not
/// flood `fs_changed` during builds/checkouts.
const FS_IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist"];

/// True when any component of `path` is one of [`FS_IGNORED_DIRS`].
fn is_noise_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            std::path::Component::Normal(name)
                if name.to_str().is_some_and(|name| FS_IGNORED_DIRS.contains(&name))
        )
    })
}

/// Install the OS-native filesystem watcher and a debounce task that coalesces raw events
/// into `fs_changed` broadcasts. The watcher handle is stored on the host so the workspace
/// allowlist changes can re-point it. Best-effort: if the platform watcher can't start,
/// live updates are simply disabled (the cockpit still works).
async fn install_fs_watcher(host: &Arc<Host>) {
    let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<String>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for path in event.paths {
                // Skip build/VCS churn (a `git checkout`, `npm install`, or `cargo build` would
                // otherwise flood the cockpit with thousands of irrelevant events).
                if is_noise_path(&path) {
                    continue;
                }
                let _ = raw_tx.send(path.to_string_lossy().to_string());
            }
        }
    });
    let Ok(watcher) = watcher else {
        eprintln!("bridge-host: filesystem watcher unavailable; live updates disabled");
        return;
    };
    *host.watcher.lock().await = Some((watcher, Vec::new()));

    {
        let host = Arc::clone(host);
        tokio::spawn(async move {
            let mut pending: HashSet<String> = HashSet::new();
            let mut ticker = tokio::time::interval(FS_DEBOUNCE);
            loop {
                tokio::select! {
                    received = raw_rx.recv() => match received {
                        Some(path) => {
                            pending.insert(path);
                        }
                        None => break,
                    },
                    _ = ticker.tick() => {
                        if !pending.is_empty() {
                            let mut paths: Vec<String> = pending.drain().collect();
                            paths.truncate(FS_PATHS_CAP);
                            let _ = host
                                .events
                                .send(BridgeEvent::fs_changed(new_id(), now_rfc3339(), paths));
                        }
                    }
                }
            }
        });
    }

    let roots = host.runtime.lock().await.workspace_roots();
    apply_watch(host, roots).await;
}

/// Re-point the watcher at `roots`: unwatch the previous set, watch each existing root
/// recursively. Called on startup and whenever the workspace allowlist changes.
async fn apply_watch(host: &Arc<Host>, roots: Vec<String>) {
    let mut guard = host.watcher.lock().await;
    let Some((watcher, watched)) = guard.as_mut() else {
        return;
    };
    for old in watched.drain(..) {
        let _ = watcher.unwatch(Path::new(&old));
    }
    for root in roots {
        if Path::new(&root).exists()
            && watcher
                .watch(Path::new(&root), RecursiveMode::Recursive)
                .is_ok()
        {
            watched.push(root);
        }
    }
}

async fn poll_active_runs(host: &Arc<Host>) {
    let run_ids: Vec<String> = {
        let active = host.active_runs.lock().await;
        active.iter().cloned().collect()
    };
    if run_ids.is_empty() {
        return;
    }
    let mut runtime = host.runtime.lock().await;
    let mut finished = Vec::new();
    for run_id in run_ids {
        match runtime.stream_events(&run_id) {
            Ok(events) => {
                for event in events {
                    let _ = host.events.send(event);
                }
            }
            Err(error) => {
                eprintln!(
                    "bridge-host: stream error for run {run_id} ({}): {}",
                    error.code, error.message
                );
                finished.push(run_id.clone());
            }
        }
        if runtime
            .run(&run_id)
            .map(|managed| managed.record.run.state.is_terminal())
            .unwrap_or(true)
        {
            finished.push(run_id);
        }
    }
    if !finished.is_empty() {
        let mut active = host.active_runs.lock().await;
        for run_id in finished {
            active.remove(&run_id);
            // Revoke the run's per-run dispatch capability token as it reaches a terminal state
            // (ADR-0098 B): a token must not outlive the parent run it was minted for, so a
            // dispatch attempted after the parent ended cannot authenticate.
            if let Some(governor) = &host.dispatch {
                governor.revoke_run(&run_id);
            }
        }
    }
}

async fn handle_socket(socket: WebSocket, host: Arc<Host>, local: bool) {
    host.connected_clients
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // A per-connection id so the launches this socket starts can be swept on disconnect.
    // A per-connection id so the terminals this socket opens can be swept when it disconnects.
    let conn_id = host.next_conn_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let mut events_rx = host.events.subscribe();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<WireFrame>(256);

    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                event = events_rx.recv() => {
                    match event {
                        Ok(event) => {
                            let frame = WireFrame::server_event(new_id(), event, now_rfc3339());
                            if send_frame(&mut sink, &frame).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // The client missed events; dropping them would corrupt
                            // the transcript, so fail fast and let it reconnect.
                            let frame = WireFrame::error(
                                new_id(),
                                BridgeError::new(
                                    "stream_lagged",
                                    "event stream lagged; reconnect to replay",
                                ),
                                now_rfc3339(),
                            );
                            let _ = send_frame(&mut sink, &frame).await;
                            break;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                frame = outbound_rx.recv() => {
                    match frame {
                        Some(frame) => {
                            if send_frame(&mut sink, &frame).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    while let Some(message) = stream.next().await {
        let Ok(message) = message else { break };
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let frame: WireFrame = match serde_json::from_str(text.as_str()) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = outbound_tx
                    .send(WireFrame::error(
                        new_id(),
                        BridgeError::new("bad_frame", error.to_string()),
                        now_rfc3339(),
                    ))
                    .await;
                continue;
            }
        };
        if let Some(command) = frame.command {
            handle_command(
                &host,
                command,
                &frame.frame_id,
                &outbound_tx,
                local,
                conn_id,
            )
            .await;
        }
    }

    writer.abort();

    // Retire every launch this connection started (ADR-0104 D2: a launch is tree-killed on the
    // owning device's disconnect; a mobile launch lives only as long as the phone is connected).
    let mine: Vec<String> = {
        let state = host.active_launches.lock().await;
        state
            .launches
            .iter()
            .filter(|(_, entry)| entry.conn_id == conn_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for launch_id in mine {
        retire_launch(&host, &launch_id, "disconnected", None).await;
    }
    // Drop any relay launches this connection parked but never confirmed (nothing spawned yet).
    host.pending_launches
        .lock()
        .await
        .retain(|_, pending| pending.conn_id != conn_id);

    // Retire every integrated terminal this connection opened (ADR-0103 D5: a session is
    // killed on device disconnect). Dropping each session tree-kills its shell.
    let mine: Vec<String> = {
        let state = host.active_terminals.lock().await;
        state
            .terminals
            .iter()
            .filter(|(_, entry)| entry.conn_id == conn_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for session_id in mine {
        retire_terminal(&host, &session_id, "disconnected").await;
    }

    // Retire every debug session this connection opened (ADR-0106 D6: a session is tree-killed,
    // adapter + debuggee, when the owning device disconnects).
    let mine: Vec<String> = {
        let state = host.active_dap.lock().await;
        state
            .sessions
            .iter()
            .filter(|(_, entry)| entry.conn_id == conn_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for session_id in mine {
        retire_dap(&host, &session_id, "disconnected").await;
    }

    // ADR-0102 D-C: a language server never outlives the cockpit it serves. When the LAST
    // client disconnects, retire every running server (a second connected device keeps them
    // alive; a reconnecting cockpit restarts servers on demand). Drop happens off the async
    // worker: it kills the process tree and joins the pump threads.
    if host
        .connected_clients
        .fetch_sub(1, std::sync::atomic::Ordering::SeqCst)
        == 1
    {
        let orphans: Vec<honeyhub_bridge::LspServer> = {
            let mut state = host.active_lsp.lock().await;
            state.pending_init.clear();
            state.init_waiters.clear();
            state.init_results.clear();
            state.servers.drain().map(|(_, server)| server).collect()
        };
        if !orphans.is_empty() {
            eprintln!(
                "[lsp] last cockpit disconnected; retiring {} language server(s)",
                orphans.len()
            );
            tokio::task::spawn_blocking(move || drop(orphans));
        }
    }
}

async fn handle_command(
    host: &Arc<Host>,
    command: ClientCommand,
    frame_id: &str,
    outbound_tx: &mpsc::Sender<WireFrame>,
    local: bool,
    conn_id: u64,
) {
    // LSP send/stop touch only the language-server map — never the runtime — so handle them
    // WITHOUT taking the runtime lock. A completion request on every keystroke must not queue
    // behind a backend run (or the 80ms poll loop) holding that lock, and a stdin write must
    // not wedge it (ADR-0102). Start still goes through the main match: it gates the root.
    if matches!(
        &command,
        ClientCommand::LspSend { .. } | ClientCommand::LspStop { .. }
    ) {
        let result = handle_lsp_command(host, command).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }

    // LaunchStop touches only the launches map, never the runtime, so handle it off-lock too.
    // Owner-checked: only the connection that started a launch may stop it.
    if let ClientCommand::LaunchStop { launch_id } = &command {
        let result = stop_owned_launch(host, launch_id, conn_id).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }

    // Terminal input/resize/close touch only the terminals map, never the runtime, the same
    // rationale as LSP send/stop above: a keystroke must not queue behind a backend run.
    // Terminal *open* still goes through the main match, where it gates the root (ADR-0103).
    if matches!(
        &command,
        ClientCommand::TerminalInput { .. }
            | ClientCommand::TerminalResize { .. }
            | ClientCommand::TerminalClose { .. }
    ) {
        let result = handle_terminal_command(host, command, conn_id).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }

    // LaunchConfirm confirms a parked RELAY launch and spawns it, off the runtime lock.
    if let ClientCommand::LaunchConfirm { confirm_id } = &command {
        let result = confirm_relay_launch(host, confirm_id, conn_id, outbound_tx).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }

    // LaunchCancel discards a parked RELAY launch the operator declined (frees its slot now).
    if let ClientCommand::LaunchCancel { confirm_id } = &command {
        host.pending_launches
            .lock()
            .await
            .retain(|id, pending| !(id == confirm_id && pending.conn_id == conn_id));
        respond(outbound_tx, frame_id, Ok(None)).await;
        return;
    }

    // DapSend / DapStop touch only the DAP map, never the runtime, so handle them off-lock too.
    // Owner-checked: only the connection that opened a debug session may drive or stop it.
    if let ClientCommand::DapSend {
        session_id,
        message,
    } = command
    {
        let result = handle_dap_send(host, &session_id, message, conn_id).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }
    if let ClientCommand::DapStop { session_id } = &command {
        let result = stop_dap_session(host, session_id, conn_id).await;
        respond(outbound_tx, frame_id, result).await;
        return;
    }

    let mut to_register: Option<String> = None;
    // Set when the workspace allowlist changes, so the watcher is re-pointed after the
    // runtime lock is released.
    let mut rewatch: Option<Vec<String>> = None;
    // Language servers whose root fell out of the allowlist on a `SetWorkspaceRoots`, moved
    // out under the lock and dropped off-lock below (a supervised server must never outlive
    // its authorization; the reader-thread join is kept off the async worker).
    let mut lsp_orphans: Vec<honeyhub_bridge::LspServer> = Vec::new();
    // Launches whose project root fell out of the allowlist on the same `SetWorkspaceRoots`,
    // retired off-lock below (ADR-0104 D2: a launch must not outlive its authorization).
    let mut launch_orphans: Vec<(String, LaunchEntry)> = Vec::new();
    // Integrated terminals whose opening root fell out of the allowlist on the same
    // `SetWorkspaceRoots`, retired off-lock below (ADR-0103 D5: a session must not outlive its
    // authorization). Each is announced closed once and its shell tree-killed on drop.
    let mut terminal_orphans: Vec<(String, TerminalEntry)> = Vec::new();
    // Debug sessions whose opening root fell out of the allowlist on the same `SetWorkspaceRoots`,
    // retired off-lock below (ADR-0106 D6: a session must not outlive its authorization).
    let mut dap_orphans: Vec<(String, DapEntry)> = Vec::new();
    // A content search validated under the runtime lock but executed after it is released
    // (grepping a big tree is slow filesystem work; holding the runtime lock through it
    // would stall every other client command).
    let mut search_job: Option<(String, String, honeyhub_bridge::ContentSearchOptions)> = None;
    // A launch gated under the runtime lock (root allowlist + host-owned target resolution) but
    // SPAWNED after it is released: spawning a process is blocking work that must not stall the
    // poll loop. Carries (local, root, target_id, open_id).
    let mut launch_job: Option<(bool, String, String, Option<String>)> = None;
    // A terminal open gated under the runtime lock (root allowlist) but SPAWNED after it is
    // released: openpty + shell spawn is blocking work that must not stall the poll loop.
    // Carries (root_allowed, root, cols, rows, open_id).
    let mut terminal_open_job: Option<(bool, String, u16, u16, Option<String>)> = None;
    // A debug session gated under the runtime lock (root allowlist) but OPENED after it is
    // released: adapter spawn is blocking work. Carries (local, root, adapter_id, config_id,
    // open_id).
    let mut dap_open_job: Option<(bool, String, String, String, Option<String>)> = None;
    let result: Result<Option<Vec<BridgeEvent>>, BridgeError> = {
        let mut runtime = host.runtime.lock().await;
        match command {
            ClientCommand::Start { request } => {
                runtime.start(*request, now_rfc3339()).map(|handle| {
                    to_register = Some(handle.run_id);
                    None
                })
            }
            ClientCommand::Reply { run_id, text } => {
                runtime.reply(&run_id, &text, now_rfc3339()).map(|_| None)
            }
            ClientCommand::Stop { run_id } => runtime.stop(&run_id, now_rfc3339()).map(|_| None),
            ClientCommand::Reconnect { request } => runtime.replay_events(&request).map(Some),
            ClientCommand::UsageSummary => {
                let summary = runtime.usage_summary();
                Ok(Some(vec![BridgeEvent::usage_summary(
                    new_id(),
                    now_rfc3339(),
                    summary,
                )]))
            }
            ClientCommand::CoachingHints => {
                let now = now_rfc3339();
                let hints = runtime.coaching_hints(&now);
                Ok(Some(vec![BridgeEvent::coaching_hints(
                    new_id(),
                    now,
                    hints,
                )]))
            }
            ClientCommand::DiscoverAgents { workspace_root } => runtime
                .discover_agents(workspace_root.as_deref())
                .map(|agents| one(BridgeEvent::agent_catalog(new_id(), now_rfc3339(), agents))),
            ClientCommand::DiscoverBackends => Ok(Some(vec![BridgeEvent::backend_catalog(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::detect_default_backends(),
            )])),
            ClientCommand::SetWorkspaceRoots { roots } => {
                rewatch = Some(roots.clone());
                runtime.set_workspace_roots(roots);
                // Update the LSP roots snapshot AND sweep orphaned servers under the ONE
                // active_lsp lock, so the two changes are atomic: no LSP send/pump can
                // observe the new roots while a server for a now-removed root is still
                // registered (ADR-0102 firm root removal + every-frame boundary). Orphans
                // are dropped off-lock below.
                let new_roots = runtime.workspace_roots();
                let mut state = host.active_lsp.lock().await;
                state.roots = honeyhub_bridge::WorkspaceAllowlist::new(new_roots);
                let orphan_keys: Vec<LspKey> = state
                    .servers
                    .keys()
                    .filter(|key| !state.roots.allows(&key.root))
                    .cloned()
                    .collect();
                for key in orphan_keys {
                    if let Some(server) = state.take_server(&key) {
                        lsp_orphans.push(server);
                    }
                }
                drop(state);
                // Update the launch roots snapshot AND sweep orphaned launches under the ONE
                // active_launches lock, so a launch's authorization is atomic with the change:
                // `start_launch` re-checks the same snapshot under this lock, so no launch can be
                // registered into a root this sweep just removed (ADR-0104 D2). Orphans are
                // retired off-lock below.
                let new_roots = runtime.workspace_roots();
                let mut launch_state = host.active_launches.lock().await;
                launch_state.roots = honeyhub_bridge::WorkspaceAllowlist::new(new_roots);
                let orphan_ids: Vec<String> = launch_state
                    .launches
                    .iter()
                    .filter(|(_, entry)| !launch_state.roots.allows(&entry.root))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in orphan_ids {
                    if let Some(entry) = launch_state.launches.remove(&id) {
                        launch_orphans.push((id, entry));
                    }
                }
                drop(launch_state);
                // Update the terminal roots snapshot AND sweep orphaned terminals under the ONE
                // active_terminals lock, so authorization is atomic with the change: `open_terminal`
                // re-checks the same snapshot under this lock, so no shell can be registered into a
                // root this sweep just removed (ADR-0103 D5). Orphans are retired off-lock below.
                let new_roots = runtime.workspace_roots();
                let mut term_state = host.active_terminals.lock().await;
                term_state.roots = honeyhub_bridge::WorkspaceAllowlist::new(new_roots);
                let orphan_ids: Vec<String> = term_state
                    .terminals
                    .iter()
                    .filter(|(_, entry)| !term_state.roots.allows(&entry.root))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in orphan_ids {
                    if let Some(entry) = term_state.terminals.remove(&id) {
                        terminal_orphans.push((id, entry));
                    }
                }
                drop(term_state);
                // Update the debug-session roots snapshot AND sweep orphaned sessions under the ONE
                // active_dap lock, so authorization is atomic with the change: `open_dap_session`
                // re-checks the same snapshot under this lock, so no session can be registered into
                // a root this sweep just removed (ADR-0106 D6). Orphans are retired off-lock below.
                let new_roots = runtime.workspace_roots();
                let mut dap_state = host.active_dap.lock().await;
                dap_state.roots = honeyhub_bridge::WorkspaceAllowlist::new(new_roots);
                let orphan_ids: Vec<String> = dap_state
                    .sessions
                    .iter()
                    .filter(|(_, entry)| !dap_state.roots.allows(&entry.root))
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in orphan_ids {
                    if let Some(entry) = dap_state.sessions.remove(&id) {
                        dap_orphans.push((id, entry));
                    }
                }
                Ok(None)
            }
            ClientCommand::BrowseDir { path } => honeyhub_bridge::browse_dir(path.as_deref())
                .map(|listing| one(BridgeEvent::dir_listing(new_id(), now_rfc3339(), listing))),
            ClientCommand::ReadFile { path } => {
                // Gate file *contents* to the user's allowlisted roots (browse lists
                // names unscoped, but reading content requires an added root).
                require(runtime.workspace_allows(&path), "file")
                    .and_then(|()| honeyhub_bridge::read_file(&path))
                    .map(|file| one(BridgeEvent::file_contents(new_id(), now_rfc3339(), file)))
            }
            ClientCommand::WriteFile { path, content } => {
                write_file_command(&runtime, &path, &content)
            }
            ClientCommand::ResolveWorkspaceFile { path } => {
                // Unscoped like browse: the user selects a .code-workspace to *add* its
                // repos as roots, so it must be readable before those roots exist. It
                // only reads the small workspace JSON (folder paths), not repo contents.
                honeyhub_bridge::resolve_workspace_file(&path).map(|folders| {
                    one(BridgeEvent::workspace_folders(
                        new_id(),
                        now_rfc3339(),
                        folders,
                    ))
                })
            }
            ClientCommand::SearchFiles { root, query } => {
                // Search is gated to an allowlisted root (it reads the tree there).
                require(runtime.workspace_allows(&root), "search root")
                    .and_then(|()| honeyhub_bridge::search_files(&root, &query))
                    .map(|results| {
                        one(BridgeEvent::search_results(
                            new_id(),
                            now_rfc3339(),
                            results,
                        ))
                    })
            }
            ClientCommand::SearchContent {
                root,
                query,
                case_sensitive,
                whole_word,
                is_regex,
            } => {
                // Content search (Find in Files) is gated to an allowlisted root exactly like the
                // filename search — it greps the files under that scope. `workspace_allows`
                // canonicalizes, so a `..`/symlink escape resolves out of the root and is denied.
                // Only the *gate* runs under the runtime lock; the grep itself is deferred to
                // blocking work after the lock is released (see `search_job` below).
                require(runtime.workspace_allows(&root), "search root").map(|()| {
                    search_job = Some((
                        root,
                        query,
                        honeyhub_bridge::ContentSearchOptions {
                            case_sensitive,
                            whole_word,
                            is_regex,
                        },
                    ));
                    None
                })
            }
            ClientCommand::WriteAgent {
                name,
                description,
                body,
                model,
                workspace_root,
            } => runtime
                .write_agent(
                    workspace_root.as_deref(),
                    &name,
                    &description,
                    &body,
                    model.as_deref(),
                )
                .map(|agent| one(BridgeEvent::agent_written(new_id(), now_rfc3339(), agent))),
            ClientCommand::ListJobs {
                extra_probes,
                extra_task_keywords,
            } => honeyhub_bridge::job_snapshot(&extra_probes, &extra_task_keywords)
                .map(|snapshot| one(BridgeEvent::job_snapshot(new_id(), now_rfc3339(), snapshot))),
            ClientCommand::DetectEnvironment => Ok(Some(vec![BridgeEvent::environment_info(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::detect_environment(),
            )])),
            ClientCommand::ListNetwork => Ok(Some(vec![BridgeEvent::network_info(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::reachable_addresses(),
            )])),
            ClientCommand::ListWork { sources } => Ok(Some(vec![BridgeEvent::work_snapshot(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::work_snapshot(&sources),
            )])),
            ClientCommand::ListServiceBus => Ok(Some(vec![BridgeEvent::service_bus_snapshot(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_snapshot(),
            )])),
            ClientCommand::ListAzureSubscriptions => {
                Ok(Some(vec![BridgeEvent::azure_subscriptions(
                    new_id(),
                    now_rfc3339(),
                    honeyhub_bridge::azure_subscriptions(),
                )]))
            }
            ClientCommand::ListKeyVaults { subscription_ids } => {
                Ok(Some(vec![BridgeEvent::key_vaults(
                    new_id(),
                    now_rfc3339(),
                    honeyhub_bridge::key_vaults(&subscription_ids),
                )]))
            }
            ClientCommand::ListVaultObjects {
                vault,
                subscription_id,
            } => Ok(Some(vec![BridgeEvent::vault_objects(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::vault_objects(&vault, &subscription_id),
            )])),
            ClientCommand::RevealSecret {
                vault,
                subscription_id,
                name,
            } => Ok(Some(vec![BridgeEvent::secret_reveal(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::reveal_secret(&vault, &subscription_id, &name),
            )])),
            ClientCommand::ScanKeyVaultExpiry { subscription_ids } => {
                Ok(Some(vec![BridgeEvent::key_vault_expiry(
                    new_id(),
                    now_rfc3339(),
                    honeyhub_bridge::scan_key_vault_expiry(&subscription_ids),
                )]))
            }
            ClientCommand::PeekServiceBus {
                namespace,
                connection_string,
                entity,
                subscription,
                dead_letter,
                count,
            } => Ok(Some(vec![BridgeEvent::service_bus_peek(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_peek(
                    &namespace,
                    connection_string.as_deref(),
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
                    count,
                ),
            )])),
            ClientCommand::ResubmitDeadLetter {
                namespace,
                connection_string,
                entity,
                subscription,
                count,
            } => Ok(Some(vec![BridgeEvent::service_bus_resubmit(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_resubmit(
                    &namespace,
                    connection_string.as_deref(),
                    &entity,
                    subscription.as_deref(),
                    count,
                ),
            )])),
            ClientCommand::PurgeServiceBus {
                namespace,
                connection_string,
                entity,
                subscription,
                dead_letter,
            } => Ok(Some(vec![BridgeEvent::service_bus_purge(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_purge(
                    &namespace,
                    connection_string.as_deref(),
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
                ),
            )])),
            ClientCommand::SendServiceBus {
                namespace,
                connection_string,
                entity,
                body,
                subject,
                content_type,
            } => Ok(Some(vec![BridgeEvent::service_bus_send(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_send(
                    &namespace,
                    connection_string.as_deref(),
                    &entity,
                    &body,
                    subject.as_deref(),
                    content_type.as_deref(),
                ),
            )])),
            ClientCommand::ReceiveServiceBus {
                namespace,
                connection_string,
                entity,
                subscription,
                dead_letter,
            } => Ok(Some(vec![BridgeEvent::service_bus_receive(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_receive(
                    &namespace,
                    connection_string.as_deref(),
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
                ),
            )])),
            ClientCommand::ListServiceBusEntities {
                namespace,
                connection_string,
            } => Ok(Some(vec![BridgeEvent::service_bus_entities(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_entities(&namespace, connection_string.as_deref()),
            )])),
            ClientCommand::ManageServiceBus {
                namespace,
                connection_string,
                op,
                entity_kind,
                entity,
                subscription,
                props,
            } => Ok(Some(vec![BridgeEvent::service_bus_manage(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_manage(
                    &namespace,
                    connection_string.as_deref(),
                    &op,
                    &entity_kind,
                    &entity,
                    subscription.as_deref(),
                    &props,
                ),
            )])),
            ClientCommand::GrafanaSummary { base_url, token } => {
                Ok(Some(vec![BridgeEvent::grafana_summary(
                    new_id(),
                    now_rfc3339(),
                    honeyhub_bridge::grafana_summary(&base_url, &token),
                )]))
            }
            ClientCommand::SentrySummary {
                base_url,
                org,
                project,
                token,
            } => Ok(Some(vec![BridgeEvent::sentry_summary(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::sentry_summary(&base_url, &org, &project, &token),
            )])),
            ClientCommand::GitStatus { root } => {
                // Git status reads the repo, so gate the root to the allowlist.
                require(runtime.workspace_allows(&root), "git root")
                    .and_then(|()| honeyhub_bridge::git_status(&root))
                    .map(|status| one(BridgeEvent::git_status(new_id(), now_rfc3339(), status)))
            }
            ClientCommand::GitDiff { root, path } => {
                require(runtime.workspace_allows(&root), "git root")
                    .and_then(|()| honeyhub_bridge::git_diff(&root, path.as_deref()))
                    .map(|diff| one(BridgeEvent::git_diff(new_id(), now_rfc3339(), diff)))
            }
            ClientCommand::GitFileVersions { root, path } => {
                require(runtime.workspace_allows(&root), "git root")
                    .and_then(|()| honeyhub_bridge::git_file_versions(&root, &path))
                    .map(|result| {
                        one(BridgeEvent::git_file_versions(
                            new_id(),
                            now_rfc3339(),
                            result,
                        ))
                    })
            }
            ClientCommand::GitOverview { root } => {
                // Discover repos under the folder + status each (multi-repo dashboard). The
                // folder is gated, exactly like a single-repo read.
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    one(BridgeEvent::git_overview(
                        new_id(),
                        now_rfc3339(),
                        honeyhub_bridge::git_overview(&root),
                    ))
                })
            }
            ClientCommand::GitBranches { root } => {
                require(runtime.workspace_allows(&root), "git root")
                    .and_then(|()| honeyhub_bridge::git_branches(&root))
                    .map(|branches| {
                        one(BridgeEvent::git_branches(new_id(), now_rfc3339(), branches))
                    })
            }
            // Git writes (confirmation-gated in the UI): gate the repo to the allowlist, run
            // the op, then return its result + a fresh status so the view updates. A failed op
            // surfaces as a `GitOp { ok: false }` event (friendlier than a transport error).
            ClientCommand::GitStage { root, paths } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "stage",
                        honeyhub_bridge::git_stage(&root, &paths),
                    ))
                })
            }
            ClientCommand::GitUnstage { root, paths } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "unstage",
                        honeyhub_bridge::git_unstage(&root, &paths),
                    ))
                })
            }
            ClientCommand::GitCommit { root, message } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "commit",
                        honeyhub_bridge::git_commit(&root, &message),
                    ))
                })
            }
            ClientCommand::GitPush { root } => require(runtime.workspace_allows(&root), "git root")
                .map(|()| {
                    Some(git_write_events(
                        &root,
                        "push",
                        honeyhub_bridge::git_push(&root),
                    ))
                }),
            ClientCommand::GitPull { root } => require(runtime.workspace_allows(&root), "git root")
                .map(|()| {
                    Some(git_write_events(
                        &root,
                        "pull",
                        honeyhub_bridge::git_pull(&root),
                    ))
                }),
            ClientCommand::GitCheckout { root, name, create } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "checkout",
                        honeyhub_bridge::git_checkout(&root, &name, create),
                    ))
                })
            }
            ClientCommand::GitDiscard {
                root,
                paths,
                untracked,
            } => require(runtime.workspace_allows(&root), "git root").map(|()| {
                Some(git_write_events(
                    &root,
                    "discard",
                    honeyhub_bridge::git_discard(&root, &paths, untracked),
                ))
            }),
            ClientCommand::GitDiscardAll { root } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "discard",
                        honeyhub_bridge::git_discard_all(&root),
                    ))
                })
            }
            ClientCommand::GitDeleteBranch { root, name, force } => {
                require(runtime.workspace_allows(&root), "git root").map(|()| {
                    Some(git_write_events(
                        &root,
                        "delete-branch",
                        honeyhub_bridge::git_delete_branch(&root, &name, force),
                    ))
                })
            }
            ClientCommand::ListSessions => Ok(Some(vec![BridgeEvent::session_list(
                new_id(),
                now_rfc3339(),
                runtime.stored_sessions(),
            )])),
            ClientCommand::SessionDetail { session_id } => {
                let (runs, transcript, usage) = runtime.stored_session_detail(&session_id);
                Ok(Some(vec![BridgeEvent::session_detail(
                    new_id(),
                    now_rfc3339(),
                    session_id,
                    runs,
                    transcript,
                    usage,
                )]))
            }
            // Thread management on the durable store. Each op answers with a refreshed
            // session_list so the requesting cockpit's view updates in one round trip.
            ClientCommand::RenameSession { session_id, title } => runtime
                .rename_stored_session(&session_id, &title)
                .map(|()| {
                    Some(vec![BridgeEvent::session_list(
                        new_id(),
                        now_rfc3339(),
                        runtime.stored_sessions(),
                    )])
                }),
            ClientCommand::DeleteSession { session_id } => {
                runtime.delete_stored_session(&session_id).map(|()| {
                    Some(vec![BridgeEvent::session_list(
                        new_id(),
                        now_rfc3339(),
                        runtime.stored_sessions(),
                    )])
                })
            }
            ClientCommand::PinSession { session_id, pinned } => {
                runtime.pin_stored_session(&session_id, pinned).map(|()| {
                    Some(vec![BridgeEvent::session_list(
                        new_id(),
                        now_rfc3339(),
                        runtime.stored_sessions(),
                    )])
                })
            }
            ClientCommand::Roadmap => {
                // Resolve a sibling Architecture repo from the workspace roots (or the env
                // override inside read_roadmap) and parse its initiatives; found:false guides
                // a new user.
                let roots = runtime.workspace_roots();
                Ok(Some(vec![BridgeEvent::roadmap(
                    new_id(),
                    now_rfc3339(),
                    honeyhub_bridge::read_roadmap(&roots),
                )]))
            }
            ClientCommand::ScaffoldArchitecture { name, location } => {
                let roots = runtime.workspace_roots();
                honeyhub_bridge::scaffold_architecture(name.as_deref(), location.as_deref(), &roots)
                    .map(|snapshot| one(BridgeEvent::roadmap(new_id(), now_rfc3339(), snapshot)))
            }
            ClientCommand::PullArchitecture => {
                let roots = runtime.workspace_roots();
                honeyhub_bridge::pull_architecture(&roots)
                    .map(|snapshot| one(BridgeEvent::roadmap(new_id(), now_rfc3339(), snapshot)))
            }
            ClientCommand::RunCheck { root, check } => {
                // Running a named check (build/test) crosses the read-only boundary like a
                // git write, so gate the repo to the allowlist first. The check id resolves
                // against host-owned definitions inside `run_check` (unknown ids come back
                // as explicit `denied` outcomes). The subprocess runs OFF the runtime lock
                // on a blocking thread — a slow test suite must not wedge the bridge — and
                // overlapping checks for the same root are refused while one is in flight.
                require(runtime.workspace_allows(&root), "check root").map(|()| {
                    spawn_check(host, root, check);
                    None
                })
            }
            ClientCommand::ProbeUsage { backend } => {
                // The plan-usage probe drives the vendor TUI in a hidden PTY for up
                // to ~25s, so it runs OFF the runtime lock on a blocking thread and
                // broadcasts its report when done. Runs in the first workspace root
                // (a directory the CLIs already trust).
                let cwd = runtime
                    .workspace_roots()
                    .first()
                    .cloned()
                    .unwrap_or_else(|| ".".to_string());
                spawn_usage_probe(host, backend, cwd);
                Ok(None)
            }
            ClientCommand::LspStart { root, language_id } => {
                // Starting a language server crosses into running an operator-installed binary,
                // so gate the root against the allowlist first (the same posture as a check).
                // Resolve/locate/spawn happen OFF the runtime lock in `spawn_lsp`, which
                // broadcasts an honest `lsp_status` (running / installed / degraded).
                require(runtime.workspace_allows(&root), "lsp root").map(|()| {
                    spawn_lsp(host, root, language_id);
                    None
                })
            }
            ClientCommand::LspSend { .. } | ClientCommand::LspStop { .. } => {
                // Handled before the runtime lock (see the early return in `handle_command`);
                // this arm exists only for match exhaustiveness and is never reached.
                Ok(None)
            }
            ClientCommand::DetectLaunchTargets { root } => {
                // Detection is a read over an allowlisted root (ADR-0104 D1), gated like ReadFile.
                require(runtime.workspace_allows(&root), "launch root").map(|()| {
                    let targets = honeyhub_bridge::launch::detect_targets(&root);
                    one(BridgeEvent::launch_targets(
                        new_id(),
                        now_rfc3339(),
                        root,
                        targets,
                    ))
                })
            }
            ClientCommand::LaunchStart {
                root,
                target_id,
                open_id,
            } => {
                // Gate the root under the runtime lock, but DEFER the spawn: starting a process
                // is blocking work that must not stall the poll loop. The host-owned target
                // resolution + spawn happen off-lock in `start_launch` (below).
                require(runtime.workspace_allows(&root), "launch root").map(|()| {
                    launch_job = Some((local, root, target_id, open_id));
                    None
                })
            }
            ClientCommand::LaunchStop { .. }
            | ClientCommand::LaunchConfirm { .. }
            | ClientCommand::LaunchCancel { .. } => {
                // Handled before the runtime lock (see the early returns in `handle_command`);
                // these arms exist only for match exhaustiveness and are never reached.
                Ok(None)
            }
            ClientCommand::TerminalOpen {
                root,
                cols,
                rows,
                open_id,
            } => {
                // Gate the root against the allowlist here (synchronously, under the runtime
                // lock), but DEFER the actual open: `TerminalSession::open` does blocking work
                // (canonicalize + openpty + spawn the shell, tens of ms on ConPTY), so it runs
                // AFTER the runtime lock is released (below) rather than stalling the poll loop
                // and every other client's command for the spawn duration.
                let allowed = runtime.workspace_allows(&root);
                terminal_open_job = Some((allowed, root, cols, rows, open_id));
                Ok(None)
            }
            ClientCommand::TerminalInput { .. }
            | ClientCommand::TerminalResize { .. }
            | ClientCommand::TerminalClose { .. } => {
                // Handled before the runtime lock (see the early return in `handle_command`);
                // these arms exist only for match exhaustiveness and are never reached.
                Ok(None)
            }
            ClientCommand::DapStart {
                root,
                adapter_id,
                config_id,
                open_id,
            } => {
                // Gate the root under the runtime lock, DEFER the open: spawning the adapter is
                // blocking work that must not stall the poll loop. The D5 desktop-local-only gate,
                // the D2 adapter resolution, and the spawn happen off-lock in `open_dap_session`.
                require(runtime.workspace_allows(&root), "debug root").map(|()| {
                    dap_open_job = Some((local, root, adapter_id, config_id, open_id));
                    None
                })
            }
            ClientCommand::DapSend { .. } | ClientCommand::DapStop { .. } => {
                // Handled before the runtime lock (see the early returns in `handle_command`);
                // these arms exist only for match exhaustiveness and are never reached.
                Ok(None)
            }
            ClientCommand::Resume { .. } => Err(BridgeError::new(
                "unsupported_command",
                "resume is not driven by the host runtime yet",
            )),
        }
    };

    if let Some(run_id) = to_register {
        host.active_runs.lock().await.insert(run_id);
    }
    // Re-point the filesystem watcher after a workspace-allowlist change (lock released).
    if let Some(roots) = rewatch {
        apply_watch(host, roots).await;
    }
    // Tear down any de-authorized language servers off-lock (Drop kills the tree + joins the
    // reader thread, which we keep off the async worker).
    for server in lsp_orphans {
        tokio::task::spawn_blocking(move || drop(server));
    }
    // Retire any de-authorized launches off-lock. Each was already removed from the map under the
    // launches lock, so exactly one path announces its stop. Kill first, then notify (see
    // `kill_launch_entry`): a removed root must stop the process immediately, never after an
    // owner-channel send that a slow client could stall.
    for (launch_id, entry) in launch_orphans {
        kill_launch_entry(&launch_id, entry, "root_removed", None);
    }
    // Run the gated launch off the runtime lock (starting a process is blocking). A LOCAL launch
    // spawns directly; a RELAY launch is host-gated (ADR-0104 D3): it does not spawn, it parks
    // awaiting the operator's confirmation and answers with `launch_confirm_required`.
    let result = match launch_job {
        Some((launch_local, root, target_id, open_id)) if result.is_ok() => {
            if launch_local {
                start_launch(host, true, conn_id, outbound_tx, root, target_id, open_id).await
            } else {
                park_relay_launch(host, conn_id, outbound_tx, root, target_id, open_id).await
            }
        }
        _ => result,
    };
    // Retire any de-authorized terminals off-lock. Each was already removed from the map under the
    // terminals lock, so exactly one path closes it. Kill first, then notify (see
    // `kill_terminal_entry`): a removed root must kill the shell immediately, never after an
    // owner-channel send that a slow client could stall.
    for (session_id, entry) in terminal_orphans {
        kill_terminal_entry(&session_id, entry, "root_removed");
    }
    // Retire any de-authorized debug sessions off-lock (ADR-0106 D6). Each was already removed
    // from the map under the active_dap lock, so exactly one path closes it. Kill first (adapter
    // + debuggee tree-kill), then announce, like the launch/terminal orphan sweeps.
    for (session_id, entry) in dap_orphans {
        kill_dap_entry(&host.events, &session_id, entry, "root_removed");
    }
    // Run a gated content search off the runtime lock, on blocking work: only this client's
    // task waits for it, never every other command.
    let result = match search_job {
        Some((root, query, options)) if result.is_ok() => {
            let search = tokio::task::spawn_blocking({
                let root = root.clone();
                move || honeyhub_bridge::search_content(&root, &query, options)
            })
            .await
            .unwrap_or_else(|_| {
                Err(BridgeError::new(
                    "search_failed",
                    "content search task failed unexpectedly",
                ))
            });
            // Freshness re-check: the root was authorized before the search ran off-lock, so
            // a concurrent SetWorkspaceRoots could have removed it while the walk read its
            // files. If the root is no longer allowlisted, discard the results rather than
            // return content from a now-deauthorized tree.
            if !host.runtime.lock().await.workspace_allows(&root) {
                Err(BridgeError::new(
                    "search_root_revoked",
                    "the search root was removed from the workspace allowlist during the search",
                ))
            } else {
                search.map(|results| {
                    one(BridgeEvent::content_search_results(
                        new_id(),
                        now_rfc3339(),
                        results,
                    ))
                })
            }
        }
        _ => result,
    };

    // Spawn a gated terminal off the runtime lock (openpty + shell spawn is blocking). The root
    // was authorized under the lock; `open_terminal` re-checks local + the allow verdict and
    // caps per connection under the terminals lock.
    let result = match terminal_open_job {
        Some((allowed, root, cols, rows, open_id)) if result.is_ok() => {
            open_terminal(
                host,
                local,
                allowed,
                conn_id,
                outbound_tx,
                root,
                cols,
                rows,
                open_id,
            )
            .await
        }
        _ => result,
    };

    // Open a gated debug session off the runtime lock (adapter spawn is blocking). The D5
    // desktop-local-only gate and D2 adapter resolution happen inside `open_dap_session`.
    let result = match dap_open_job {
        Some((local, root, adapter_id, config_id, open_id)) if result.is_ok() => {
            open_dap_session(
                host,
                local,
                conn_id,
                outbound_tx,
                root,
                adapter_id,
                config_id,
                open_id,
            )
            .await
        }
        _ => result,
    };

    respond(outbound_tx, frame_id, result).await;
}

/// Emit a command's result over the wire: any success events followed by an ack, a bare ack
/// for a no-event success, or a frame-id-tagged error frame so the client can correlate the
/// failure. Shared by the runtime path and the off-lock LSP path.
async fn respond(
    outbound_tx: &mpsc::Sender<WireFrame>,
    frame_id: &str,
    result: Result<Option<Vec<BridgeEvent>>, BridgeError>,
) {
    match result {
        Ok(Some(events)) => {
            for event in events {
                let frame = WireFrame::server_event(new_id(), event, now_rfc3339());
                let _ = outbound_tx.send(frame).await;
            }
            let _ = outbound_tx
                .send(WireFrame::ack(new_id(), frame_id, now_rfc3339()))
                .await;
        }
        Ok(None) => {
            let _ = outbound_tx
                .send(WireFrame::ack(new_id(), frame_id, now_rfc3339()))
                .await;
        }
        Err(error) => {
            // Tag the error with the originating frame id so the client can
            // correlate it and surface the failure (e.g. a disallowed workspace).
            let mut error_frame = WireFrame::error(new_id(), error, now_rfc3339());
            error_frame.ack_frame_id = Some(frame_id.to_string());
            let _ = outbound_tx.send(error_frame).await;
        }
    }
}

/// Handle an LSP send/stop without the runtime lock. Send frames the message to the running
/// server for (root, language); stop retires + kills it. Both key off the canonical root.
async fn handle_lsp_command(
    host: &Arc<Host>,
    command: ClientCommand,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    match command {
        ClientCommand::LspSend {
            root,
            language_id,
            message,
        } => {
            let mut message = message;
            let key = LspKey::new(&root, &language_id);
            // A shared server serves multiple cockpits; one cockpit's `shutdown` / `exit`
            // must not terminate the server out from under the others. Server lifecycle is
            // host-owned (LspStop / disconnect teardown / root removal), so these are not
            // forwarded. A request-shaped `shutdown` (it carries an id) still needs a
            // JSON-RPC response or the client's `sendRequest("shutdown")` waits for its
            // timeout, so the host synthesizes the `null` result; `exit` is a notification
            // (no id) and is simply dropped.
            if matches!(
                message.get("method").and_then(|m| m.as_str()),
                Some("shutdown" | "exit")
            ) {
                if let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() {
                    let response =
                        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                    return Ok(Some(vec![BridgeEvent::lsp_message(
                        new_id(),
                        now_rfc3339(),
                        root.clone(),
                        language_id.clone(),
                        response,
                    )]));
                }
                return Ok(None);
            }
            // The proxy is a URI-validating gateway, not a dumb pipe (ADR-0102 D-G):
            // command/config methods are denied, initializationOptions stripped, and every
            // file URI must resolve inside THIS server's own canonical root (one server /
            // one root). Validation runs against the roots snapshot HELD in active_lsp, and
            // the root re-check + the server write happen under that SAME lock, so a
            // concurrent SetWorkspaceRoots (which updates the snapshot and sweeps servers
            // under the same lock) can never slip a frame to a server whose root it is
            // removing (ADR-0102 firm root removal).
            let mut state = host.active_lsp.lock().await;
            if !state.roots.allows(&key.root) {
                eprintln!("[lsp] refused frame for a deauthorized root ({language_id} in {root})");
                return Err(BridgeError::new(
                    "lsp_root_not_allowed",
                    "the language server's workspace root is no longer allowlisted",
                ));
            }
            let allowlist = honeyhub_bridge::WorkspaceAllowlist::new(vec![key.root.clone()]);
            if let Err(error) =
                honeyhub_bridge::lsp::sanitize_client_message(&mut message, &allowlist)
            {
                eprintln!(
                    "[lsp] denied client frame ({language_id} in {root}): {}",
                    error.message
                );
                return Err(error);
            }
            // Host-owned initialization (LSP allows exactly one initialize per server): the
            // first forwards, one arriving while it is in flight is coalesced, one after the
            // result caches is answered from the cache. Never a duplicate to the server.
            if message.get("method").and_then(|m| m.as_str()) == Some("initialize") {
                let request_id = message.get("id").filter(|id| !id.is_null()).cloned();
                match state.on_initialize(&key, request_id.clone()) {
                    InitDecision::Forward => {} // fall through to write it to the server
                    InitDecision::Coalesced => return Ok(None),
                    InitDecision::ReplyCached(cached) => {
                        return Ok(request_id.map(|id| {
                            vec![BridgeEvent::lsp_message(
                                new_id(),
                                now_rfc3339(),
                                root.clone(),
                                language_id.clone(),
                                serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": cached }),
                            )]
                        }));
                    }
                }
            }
            match state.servers.get_mut(&key) {
                Some(server) => server.write_message(&message).map(|()| None),
                None => Err(BridgeError::new(
                    "lsp_not_running",
                    "no language server is running for this file's language",
                )),
            }
        }
        ClientCommand::LspStop { root, language_id } => {
            let key = LspKey::new(&root, &language_id);
            let removed = host.active_lsp.lock().await.take_server(&key);
            if let Some(server) = removed {
                // Drop off the async worker — Drop kills the tree and joins the reader thread.
                tokio::task::spawn_blocking(move || drop(server));
            }
            Ok(None)
        }
        _ => Err(BridgeError::new(
            "unsupported_command",
            "not an lsp command",
        )),
    }
}

/// Resolve + locate + spawn (or reuse) a language server for `language_id` in `root`,
/// without the runtime lock, then pump its inbound LSP messages to every cockpit. Every exit
/// path broadcasts a single honest `lsp_status`, so the client always knows whether to light
/// up LSP features or keep its in-file IntelliSense (ADR-0102 / ADR-0090 D4).
fn spawn_lsp(host: &Arc<Host>, root: String, language_id: String) {
    let host = Arc::clone(host);
    tokio::spawn(async move {
        let status = |installed: bool, running: bool, server_id: &str, reason: &str| {
            BridgeEvent::lsp_status(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::LspStatus {
                    root: root.clone(),
                    language_id: language_id.clone(),
                    server_id: server_id.to_string(),
                    installed,
                    running,
                    reason: reason.to_string(),
                },
            )
        };

        // 1. Resolve the language id against the host's own allowlist (never a command line).
        let Some(spec) = honeyhub_bridge::lsp::resolve_server(&language_id) else {
            let _ = host.events.send(status(
                false,
                false,
                "",
                "no language server is allowlisted for this language",
            ));
            return;
        };
        let key = LspKey::new(&root, &language_id);

        // 2. Reuse a running server for this (language, root) across files.
        {
            let mut state = host.active_lsp.lock().await;
            if let Some(server) = state.servers.get_mut(&key) {
                if server.poll_exit().is_none() {
                    let server_id = server.server_id().to_string();
                    let _ = host.events.send(status(
                        true,
                        true,
                        &server_id,
                        "language server already running",
                    ));
                    return;
                }
                // A dead husk lingered — drop it (and its stale init tracking) and re-spawn.
                let dead = state.take_server(&key);
                drop(dead);
            }
        }

        // 3. Locate the operator-installed binary (honest "not installed" when absent).
        let Some(program) = honeyhub_bridge::lsp::locate(&spec) else {
            let _ = host.events.send(status(
                false,
                false,
                spec.server_id,
                "language server not installed (the bridge locates, never downloads) — in-file IntelliSense stays on",
            ));
            return;
        };

        // 3b. Re-check authorization immediately before spawn: the LspStart gate ran before
        // the async resolve/locate work, so a concurrent SetWorkspaceRoots may have removed
        // the root since. (The post-spawn registration re-checks again under the active_lsp
        // lock to close the register-side race; this check avoids even spawning a process
        // for a root that was just deauthorized.)
        if !host.runtime.lock().await.workspace_allows(&root) {
            let _ = host.events.send(status(
                true,
                false,
                spec.server_id,
                "workspace root was removed before the language server could start",
            ));
            return;
        }

        // 4. Spawn shell-free, in its own process group, scoped to the allowlisted root.
        let (server, inbound) =
            match honeyhub_bridge::LspServer::spawn(program, spec.args, &root, spec.server_id) {
                Ok(pair) => pair,
                Err(error) => {
                    let _ = host.events.send(status(
                        true,
                        false,
                        spec.server_id,
                        &format!("could not start language server: {}", error.message),
                    ));
                    return;
                }
            };

        // 5. Register (reconciling a start race: if a concurrent start won, drop ours).
        // Authorization is RE-CHECKED here against the roots snapshot HELD in active_lsp,
        // because the LspStart gate ran before the async locate/spawn work and a concurrent
        // SetWorkspaceRoots may have removed the root since. Since SetWorkspaceRoots updates
        // that snapshot and sweeps orphans under this same lock, a server can never be
        // registered for a deauthorized root and then missed by the sweep.
        let server_process_id = {
            let mut state = host.active_lsp.lock().await;
            if !state.roots.allows(&key.root) {
                drop(state);
                tokio::task::spawn_blocking(move || drop(server));
                let _ = host.events.send(status(
                    true,
                    false,
                    spec.server_id,
                    "workspace root was removed before the language server registered",
                ));
                return;
            }
            // Re-check the client count under the SAME active_lsp lock the disconnect
            // teardown drains under: if the last cockpit vanished during the async
            // locate/spawn, registering now would let the server outlive every client
            // (the teardown that already ran would never see it).
            if host
                .connected_clients
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                drop(state);
                tokio::task::spawn_blocking(move || drop(server));
                let _ = host.events.send(status(
                    true,
                    false,
                    spec.server_id,
                    "cockpit disconnected before the language server registered",
                ));
                return;
            }
            if state.servers.contains_key(&key) {
                drop(state);
                tokio::task::spawn_blocking(move || drop(server));
                let _ = host.events.send(status(
                    true,
                    true,
                    spec.server_id,
                    "language server already running",
                ));
                return;
            }
            let process_id = server.process_id();
            state.servers.insert(key.clone(), server);
            process_id
        };
        pump_lsp(
            &host,
            key,
            server_process_id,
            root.clone(),
            language_id.clone(),
            inbound,
        );
        let _ = host.events.send(status(
            true,
            true,
            spec.server_id,
            "language server running",
        ));
    });
}

/// Pump one server's inbound LSP messages to every cockpit until it exits, then retire it and
/// broadcast an `lsp_status` so the client falls back to in-file IntelliSense. Runs on a
/// blocking thread (the reader channel is synchronous); `blocking_lock` is the sanctioned way
/// to touch the async map from there.
fn pump_lsp(
    host: &Arc<Host>,
    key: LspKey,
    process_id: u32,
    root: String,
    language_id: String,
    inbound: std::sync::mpsc::Receiver<serde_json::Value>,
) {
    let host = Arc::clone(host);
    tokio::task::spawn_blocking(move || {
        while let Ok(message) = inbound.recv() {
            // ADR-0102 D-G, server-to-client direction: the root check, the URI/command
            // filtering, and the broadcast/reply all happen under the ONE active_lsp lock,
            // so a concurrent SetWorkspaceRoots (which updates the roots snapshot + sweeps
            // servers under the same lock) can never let a frame from a now-removed root
            // reach a cockpit. If our server is no longer the one under our key (stopped /
            // swept / a respawn owns it) or its root is deauthorized, the frame is dropped.
            let mut state = host.active_lsp.blocking_lock();
            let ours = state.servers.get(&key).map(|s| s.process_id()) == Some(process_id);
            if !ours || !state.roots.allows(&key.root) {
                eprintln!(
                    "[lsp] dropped server frame for a retired/deauthorized server ({language_id} in {root})"
                );
                continue;
            }
            // Cache the InitializeResult when the FIRST cockpit's initialize response
            // returns (host-owned initialization), then answer every cockpit coalesced
            // while it was in flight, so none forwarded a duplicate and all get the real
            // capabilities.
            let is_response = message.get("id").is_some() && message.get("method").is_none();
            if is_response && state.pending_init.get(&key) == message.get("id") {
                if let Some(result) = message.get("result").cloned() {
                    state.init_results.insert(key.clone(), result.clone());
                    for waiter_id in state.init_waiters.remove(&key).unwrap_or_default() {
                        let response = serde_json::json!({
                            "jsonrpc": "2.0", "id": waiter_id, "result": result
                        });
                        let _ = host.events.send(BridgeEvent::lsp_message(
                            new_id(),
                            now_rfc3339(),
                            root.clone(),
                            language_id.clone(),
                            response,
                        ));
                    }
                }
                state.pending_init.remove(&key);
            }
            let allowlist = honeyhub_bridge::WorkspaceAllowlist::new(vec![key.root.clone()]);
            match honeyhub_bridge::lsp::filter_server_message(message, &allowlist) {
                honeyhub_bridge::lsp::ServerFrameAction::Forward(message) => {
                    let _ = host.events.send(BridgeEvent::lsp_message(
                        new_id(),
                        now_rfc3339(),
                        root.clone(),
                        language_id.clone(),
                        message,
                    ));
                }
                honeyhub_bridge::lsp::ServerFrameAction::Drop => {
                    eprintln!("[lsp] dropped out-of-root server frame ({language_id} in {root})");
                }
                honeyhub_bridge::lsp::ServerFrameAction::Reply(reply) => {
                    eprintln!("[lsp] answered server request centrally ({language_id} in {root})");
                    // `ours` above already confirmed this is the server THIS pump owns.
                    if let Some(server) = state.servers.get_mut(&key) {
                        let _ = server.write_message(&reply);
                    }
                }
            }
        }
        // The channel disconnected => the server's stdout hit EOF => it exited. Retire it,
        // but ONLY if the entry under our key is still OUR process: a concurrent respawn
        // (LspStart after our server exited) may already hold the key, and evicting it
        // would cause flapping restarts. Identity-checked by the pid captured at spawn.
        let retired = {
            let mut state = host.active_lsp.blocking_lock();
            if state.servers.get(&key).map(|s| s.process_id()) == Some(process_id) {
                let removed = state.take_server(&key);
                drop(state);
                drop(removed);
                true
            } else {
                false
            }
        };
        // Only signal the fallback when WE actually retired our own server. If a respawn
        // holds the key, it is running and owns the status.
        if retired {
            let _ = host.events.send(BridgeEvent::lsp_status(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::LspStatus {
                    root,
                    language_id,
                    server_id: String::new(),
                    installed: true,
                    running: false,
                    reason: "language server exited".to_string(),
                },
            ));
        }
    });
}

async fn send_frame(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: &WireFrame,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(frame).map_err(axum::Error::new)?;
    sink.send(Message::Text(text.into())).await
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Wrap a host-synthesized `BridgeEvent` as a `server_event` wire frame, for routing an event to
/// one owning connection's outbound sink (rather than the device-wide broadcast).
fn server_event_frame(event: BridgeEvent) -> WireFrame {
    WireFrame::server_event(new_id(), event, now_rfc3339())
}

/// Unix-millis wall clock, for the pending-launch TTL (monotonicity is not required, just a
/// coarse "has it been parked too long" check).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Run a plan-usage probe without holding the runtime lock: resolve the backend's
/// CLI program (honoring the same env overrides the adapters use), execute the PTY
/// probe on a blocking thread, and **broadcast** the report so every connected
/// cockpit sees the refreshed meters.
fn spawn_usage_probe(host: &Arc<Host>, backend: honeyhub_bridge::AgentBackend, cwd: String) {
    let host = Arc::clone(host);
    tokio::spawn(async move {
        let refuse = |host: &Host, reason: &str| {
            let _ = host.events.send(BridgeEvent::usage_probe(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::UsageProbeReport {
                    backend,
                    ok: false,
                    windows: Vec::new(),
                    raw: reason.to_string(),
                    captured_at: now_rfc3339(),
                },
            ));
        };
        // A vendor CLI only launches inside an allowlisted workspace root (the same
        // trust posture as every other local exec) — no root, no probe.
        if cwd.trim().is_empty() || cwd.trim() == "." {
            refuse(
                &host,
                "no allowlisted workspace root to run the probe in — add one in Settings",
            );
            return;
        }
        // Single-flight per backend: each probe boots a full vendor TUI; repeated
        // clicks or multiple cockpits must not stack hidden sessions.
        let probe_key = format!("{backend:?}");
        if !host.active_probes.lock().await.insert(probe_key.clone()) {
            refuse(&host, "a usage probe for this backend is already running");
            return;
        }
        let program = match backend {
            honeyhub_bridge::AgentBackend::ClaudeLocal => {
                std::env::var("HONEYHUB_CLAUDE_PROGRAM").unwrap_or_else(|_| "claude".to_string())
            }
            honeyhub_bridge::AgentBackend::CodexLocal => {
                std::env::var("HONEYHUB_CODEX_PROGRAM").unwrap_or_else(|_| "codex".to_string())
            }
            honeyhub_bridge::AgentBackend::CopilotLocal => "copilot".to_string(),
        };
        let captured_at = now_rfc3339();
        let report = tokio::task::spawn_blocking(move || {
            honeyhub_bridge::probe_usage(backend, &program, &cwd, captured_at)
        })
        .await
        .unwrap_or_else(|_| honeyhub_bridge::UsageProbeReport {
            backend,
            ok: false,
            windows: Vec::new(),
            raw: "the probe task panicked or was cancelled".to_string(),
            captured_at: now_rfc3339(),
        });
        host.active_probes.lock().await.remove(&probe_key);
        let _ = host
            .events
            .send(BridgeEvent::usage_probe(new_id(), now_rfc3339(), report));
    });
}

/// Run a named check without holding the runtime lock: reserve the per-root
/// in-flight slot (refusing overlaps with an explicit `denied` outcome), execute on
/// a blocking thread (the runner itself enforces the id allowlist, the timeout with
/// a process-tree kill, and output caps), and **broadcast** the `check_result` so
/// every connected cockpit sees it — including one that reconnected mid-check, as
/// long as it is connected when the check finishes.
fn spawn_check(host: &Arc<Host>, root: String, check: String) {
    let host = Arc::clone(host);
    tokio::spawn(async move {
        let publish = |outcome: honeyhub_bridge::CheckOutcome| {
            let _ = host
                .events
                .send(BridgeEvent::check_result(new_id(), now_rfc3339(), outcome));
        };
        // Key the guard on the canonical path, so two spellings of the same repo
        // ("C:/work" vs "C:\work\.") cannot stack subprocesses in one working tree.
        let guard_key = std::fs::canonicalize(&root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.clone());
        if !host.active_checks.lock().await.insert(guard_key.clone()) {
            publish(honeyhub_bridge::CheckOutcome::denied(
                &root,
                &check,
                honeyhub_bridge::CheckDenialReason::Overlap,
                "a check is already running in this repo",
            ));
            return;
        }

        let run_root = root.clone();
        let run_check_id = check.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            honeyhub_bridge::run_check(&run_root, &run_check_id)
        })
        .await
        .unwrap_or_else(|_| {
            honeyhub_bridge::CheckOutcome::denied(
                &root,
                &check,
                honeyhub_bridge::CheckDenialReason::TaskFailed,
                "the check task panicked or was cancelled",
            )
        });
        host.active_checks.lock().await.remove(&guard_key);
        publish(outcome);
    });
}

/// Start a project launch off the runtime lock (ADR-0104 D1/D2): resolve the host-owned target id
/// (deny an unknown id), spawn the supervised child WITHOUT holding a lock (spawning is blocking),
/// then register it under the launches lock only after re-checking the roots snapshot held in that
/// same lock. Keeping the roots snapshot inside the launches lock makes the authorization check
/// atomic with registration, so a concurrent `SetWorkspaceRoots` cannot leave a launch running in
/// a just-removed root; if it did remove the root during the spawn, the just-spawned child is
/// killed and the launch denied.
async fn start_launch(
    host: &Arc<Host>,
    local: bool,
    conn_id: u64,
    owner: &mpsc::Sender<WireFrame>,
    root: String,
    target_id: String,
    open_id: Option<String>,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    let canonical = std::fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.clone());
    // Host-owned resolution: re-detect and find the id; an unknown id runs nothing (D1).
    let Some(target) = honeyhub_bridge::launch::resolve_target(&canonical, &target_id) else {
        return Err(BridgeError::new(
            "launch_denied",
            format!("no detected launch target '{target_id}' in this project"),
        ));
    };

    // Pre-spawn gate: check the roots snapshot AND the per-connection cap BEFORE spawning, so an
    // over-limit (or de-authorized) request never briefly runs repository code before being
    // killed. (A rare concurrent double-start could exceed the cap by one; that is a bounded
    // over-count, not an un-gated spawn.)
    {
        let state = host.active_launches.lock().await;
        if !state.roots.allows(&canonical) {
            return Err(BridgeError::new(
                "launch_root_revoked",
                "the project root was removed from the workspace allowlist before launch",
            ));
        }
        let open_here = state
            .launches
            .values()
            .filter(|entry| entry.conn_id == conn_id)
            .count();
        if open_here >= LAUNCH_MAX_PER_CONN {
            return Err(BridgeError::new(
                "launch_limit",
                format!(
                    "too many launches on this connection (max {LAUNCH_MAX_PER_CONN}); stop one first"
                ),
            ));
        }
    }

    // Spawn OFF the lock (CreateProcess is blocking and must not stall the poll loop or wedge the
    // launches lock the reaper/stop/disconnect paths need).
    let (session, receiver) = honeyhub_bridge::launch::LaunchSession::spawn(&target, &canonical)?;

    // Register under the launches lock, re-checking the roots snapshot held in that same lock so
    // the authorization is atomic with the insert. If the root was removed while we spawned, kill
    // the orphan and deny rather than leave it running in a de-authorized tree.
    let launch_id = new_id();
    {
        let mut state = host.active_launches.lock().await;
        if !state.roots.allows(&canonical) {
            drop(state);
            tokio::task::spawn_blocking(move || drop(session));
            return Err(BridgeError::new(
                "launch_root_revoked",
                "the project root was removed from the workspace allowlist before launch",
            ));
        }
        // Audit line (ADR-0104 D7): target id, project root, and whether the launch was local or
        // relay-reached, so a launch is traceable from the bridge console.
        eprintln!(
            "[launch] {launch_id} target={target_id} root={canonical} {} (conn {conn_id})",
            if local { "local" } else { "relay" }
        );
        state.launches.insert(
            launch_id.clone(),
            LaunchEntry {
                session,
                root: canonical,
                conn_id,
                owner: owner.clone(),
            },
        );
    }

    // Announce the start to the OWNING connection, on the SAME sink the output rides, BEFORE
    // spawning the pump, so the cockpit adopts the launch id before the first output chunk and no
    // other device ever sees this launch's stream. The command itself just acks.
    let _ = owner
        .send(server_event_frame(BridgeEvent::launch_started(
            new_id(),
            now_rfc3339(),
            launch_id.clone(),
            target_id,
            open_id,
        )))
        .await;
    spawn_launch_pump(launch_id, receiver, owner.clone());
    Ok(None)
}

/// Open an integrated terminal (ADR-0103), gated as the sharpest D9 supervised-exec action:
/// refused to a relay connection (desktop-local-only, D3), anchored to an allowlisted root
/// (D2), and capped per connection. Spawned off-lock, then registered under an atomic roots
/// re-check; the owning connection receives a `terminal_opened` and all subsequent output.
#[allow(clippy::too_many_arguments)]
async fn open_terminal(
    host: &Arc<Host>,
    local: bool,
    root_allowed: bool,
    conn_id: u64,
    owner: &mpsc::Sender<WireFrame>,
    root: String,
    cols: u16,
    rows: u16,
    open_id: Option<String>,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    if !local {
        return Err(BridgeError::new(
            "terminal_denied",
            "the integrated terminal is desktop-local-only; a relay connection cannot open one (ADR-0103 D3)",
        ));
    }
    require(root_allowed, "terminal root")?;
    // Canonicalize for a stable cwd and a root that matches the allowlist re-check on removal.
    let canonical = std::fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.clone());

    // Spawn OFF any lock (openpty + shell spawn is blocking and must not stall the poll loop or
    // wedge the terminals lock the reaper/retire/disconnect paths need).
    let (session, receiver) =
        honeyhub_bridge::terminal::TerminalSession::open(&canonical, cols, rows)?;
    let session_id = new_id();
    let last_activity = Arc::new(AtomicU64::new(now_millis()));
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pump_last_activity = Arc::clone(&last_activity);
    let pump_closed = Arc::clone(&closed);
    let pump_owner = owner.clone();

    // Register under the terminals lock, re-checking the roots snapshot held in the SAME lock so
    // authorization is atomic with the insert. If the root was removed while we spawned, kill the
    // orphan and deny rather than leave a shell in a de-authorized tree.
    {
        let mut state = host.active_terminals.lock().await;
        if !state.roots.allows(&canonical) {
            drop(state);
            tokio::task::spawn_blocking(move || drop(session));
            return Err(BridgeError::new(
                "terminal_root_revoked",
                "the workspace root was removed from the allowlist before the terminal opened",
            ));
        }
        let open_here = state
            .terminals
            .values()
            .filter(|entry| entry.conn_id == conn_id)
            .count();
        if open_here >= TERMINAL_MAX_PER_CONN {
            drop(state);
            tokio::task::spawn_blocking(move || drop(session));
            return Err(BridgeError::new(
                "terminal_limit",
                format!(
                    "too many open terminals on this connection (max {TERMINAL_MAX_PER_CONN}); close one first"
                ),
            ));
        }
        // Audit line (ADR-0103 D6): session id, opening root, and owning connection, so a
        // terminal is traceable from the bridge console (contents are never logged).
        eprintln!("[terminal] {session_id} opened in {canonical} (conn {conn_id})");
        state.terminals.insert(
            session_id.clone(),
            TerminalEntry {
                session,
                root: canonical,
                conn_id,
                owner: owner.clone(),
                last_activity,
                closed,
            },
        );
    }

    // Announce the open to the OWNING connection, on the SAME channel the output rides, BEFORE
    // spawning the pump. Routing both through the owner's sink keeps ordering (the cockpit adopts
    // the id, then the first output matches) AND keeps a shell's stream off every other cockpit
    // (ADR-0103 D1 ownership). The command itself just acks.
    let _ = owner
        .send(server_event_frame(BridgeEvent::terminal_opened(
            new_id(),
            now_rfc3339(),
            session_id.clone(),
            open_id,
        )))
        .await;
    spawn_terminal_pump(
        Arc::clone(host),
        session_id,
        receiver,
        pump_owner,
        pump_last_activity,
        pump_closed,
    );
    Ok(None)
}

/// Retire a launch: remove it from the map, announce its stop to the OWNING connection, and
/// tree-kill the process group on a blocking task (Drop kills the tree). The map removal is the
/// mutex: whichever path removes an entry announces its stop, and a second path finds it already
/// gone, so the stop is announced exactly once. `exit_code` is the process exit code on the
/// natural-exit path (from the watchdog), and `None` when the launch was killed.
async fn retire_launch(host: &Arc<Host>, launch_id: &str, reason: &str, exit_code: Option<i32>) {
    let removed = host.active_launches.lock().await.launches.remove(launch_id);
    if let Some(entry) = removed {
        kill_launch_entry(launch_id, entry, reason, exit_code);
    }
}

/// Tear down a launch entry we already removed from the map. **Kill first**: the process group is
/// tree-killed (via `Drop`) on a blocking task BEFORE anything touches the owner channel, so a full
/// or slow owner sink can never delay enforcement (forced stop, idle, root removal) while the
/// process keeps running. Only after the kill is scheduled do we deliver the stop event, and we
/// deliver it on a DETACHED task so a backpressured client cannot stall the caller's teardown loop
/// (the exit watchdog and the root-removal sweep both retire in a loop). The map removal is the
/// mutex, so exactly one path reaches here for a given launch and the stop is announced once.
fn kill_launch_entry(launch_id: &str, entry: LaunchEntry, reason: &str, exit_code: Option<i32>) {
    let LaunchEntry { session, owner, .. } = entry;
    // KILL FIRST (Drop tree-kills the process group; spawn_blocking keeps the join off the runtime).
    tokio::task::spawn_blocking(move || drop(session));
    // The frame is built synchronously (so `reason` need not outlive this call); only the owner
    // sink and the built frame move into the detached notifier.
    let frame = server_event_frame(BridgeEvent::launch_stopped(
        new_id(),
        now_rfc3339(),
        launch_id.to_string(),
        reason,
        exit_code,
    ));
    tokio::spawn(async move {
        let _ = owner.send(frame).await;
    });
}

/// Spawn the per-launch output pump: a std thread draining the process's tagged byte channel,
/// base64ing each chunk, and routing it as a `launch_output` to the OWNING connection ONLY (raw
/// process output is sensitive work content, ADR-0104 D2 / D11, so it never reaches another
/// device). `blocking_send` backpressures a slow owner; a send error means the owner disconnected,
/// so the pump stops. Process exit is detected by the launch watchdog (which polls the child and
/// retires it with its exit code), so a descendant that keeps an output pipe open does not prevent
/// the launch from being reaped.
fn spawn_launch_pump(
    launch_id: String,
    receiver: std::sync::mpsc::Receiver<honeyhub_bridge::launch::LaunchChunk>,
    owner: mpsc::Sender<WireFrame>,
) {
    std::thread::spawn(move || {
        use base64::Engine;
        while let Ok(chunk) = receiver.recv() {
            let stream = match chunk.stream {
                honeyhub_bridge::launch::LaunchStream::Stdout => "stdout",
                honeyhub_bridge::launch::LaunchStream::Stderr => "stderr",
            };
            let encoded = base64::engine::general_purpose::STANDARD.encode(&chunk.data);
            let frame = server_event_frame(BridgeEvent::launch_output(
                new_id(),
                now_rfc3339(),
                launch_id.clone(),
                stream,
                encoded,
            ));
            if owner.blocking_send(frame).is_err() {
                break;
            }
        }
    });
}

/// Cap on debug sessions a single connection may hold at once. Each is two coupled processes
/// (adapter + debuggee), the heaviest supervised unit in the exec family (ADR-0106 D6), so the
/// per-connection ceiling is low.
const DAP_MAX_PER_CONN: usize = 4;
/// Environment override (seconds) for the debug idle-timeout watchdog; `0` disables it. A debug
/// session with no DAP traffic in either direction past this is retired (ADR-0106 D6).
const DAP_IDLE_ENV: &str = "HONEYHUB_DAP_IDLE_SECS";
/// Default debug idle timeout: 30 minutes of no DAP traffic.
const DAP_IDLE_DEFAULT_SECS: u64 = 30 * 60;
/// How often the debug idle watchdog sweeps for expired sessions.
const DAP_IDLE_SWEEP: Duration = Duration::from_secs(60);

/// The configured debug idle timeout in milliseconds (`0` disables the watchdog).
fn dap_idle_ms() -> u64 {
    std::env::var(DAP_IDLE_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DAP_IDLE_DEFAULT_SECS)
        .saturating_mul(1000)
}

/// Open a debug session (ADR-0106): the sharpest supervised-exec action after the terminal.
/// Desktop-local-only (D5): a relay connection is refused. Host-owned adapter selection (D2):
/// the named `adapter_id` is resolved against the allowlist table and located on PATH, never a
/// client command line. Anchored to an allowlisted root, spawned off-lock, then registered under
/// an atomic roots re-check. The open is announced DEVICE-WIDE (self-announcing, D6); subsequent
/// `dap_message` frames go ONLY to the owning connection (they can carry runtime memory, D7/D9).
#[allow(clippy::too_many_arguments)]
async fn open_dap_session(
    host: &Arc<Host>,
    local: bool,
    conn_id: u64,
    owner: &mpsc::Sender<WireFrame>,
    root: String,
    adapter_id: String,
    config_id: String,
    open_id: Option<String>,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    if !local {
        return Err(BridgeError::new(
            "dap_denied",
            "debugging is desktop-local-only; a relay connection cannot open a debug session by default (ADR-0106 D5)",
        ));
    }
    // D2: resolve the adapter id against the host-owned table (deny unknown), and locate the
    // operator-installed binary. An absent adapter is the honest "no debugger" signal (D8), not
    // an error the client can turn into execution.
    let Some(spec) = honeyhub_bridge::dap::resolve_adapter(&adapter_id) else {
        return Err(BridgeError::new(
            "dap_adapter_unknown",
            format!("'{adapter_id}' is not an allowlisted debug adapter"),
        ));
    };
    let Some(program) = honeyhub_bridge::dap::locate(&spec) else {
        return Err(BridgeError::new(
            "dap_adapter_not_installed",
            format!("the '{adapter_id}' debug adapter is not installed; Run is still available"),
        ));
    };
    let canonical = std::fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.clone());

    // Pre-spawn gate: roots + per-connection cap BEFORE spawning the adapter.
    {
        let state = host.active_dap.lock().await;
        if !state.roots.allows(&canonical) {
            return Err(BridgeError::new(
                "dap_root_revoked",
                "the workspace root was removed from the allowlist before the debug session opened",
            ));
        }
        let open_here = state
            .sessions
            .values()
            .filter(|entry| entry.conn_id == conn_id)
            .count();
        if open_here >= DAP_MAX_PER_CONN {
            return Err(BridgeError::new(
                "dap_limit",
                format!("too many debug sessions on this connection (max {DAP_MAX_PER_CONN}); stop one first"),
            ));
        }
    }

    // Spawn the adapter OFF the lock (spawn is blocking and must not stall the poll loop or wedge
    // the active_dap lock the reaper / stop / disconnect paths need).
    let (adapter, receiver) =
        honeyhub_bridge::dap::DapAdapter::spawn(program, spec.args, &canonical, spec.adapter_id)?;
    let session_id = new_id();
    let last_activity = Arc::new(AtomicU64::new(now_millis()));

    // Register under the active_dap lock, re-checking the roots snapshot held in that same lock so
    // authorization is atomic with the insert. If the root was removed while we spawned, kill the
    // orphan and deny rather than leave an adapter running in a de-authorized tree.
    {
        let mut state = host.active_dap.lock().await;
        if !state.roots.allows(&canonical) {
            drop(state);
            tokio::task::spawn_blocking(move || drop(adapter));
            return Err(BridgeError::new(
                "dap_root_revoked",
                "the workspace root was removed from the allowlist before the debug session opened",
            ));
        }
        // Audit line (ADR-0106 D7): session id, adapter id, workspace root, and owning connection,
        // so a debug session is traceable from the bridge console (steps / evaluates are NOT logged).
        eprintln!(
            "[dap] {session_id} adapter={adapter_id} config={config_id} root={canonical} (conn {conn_id})"
        );
        state.sessions.insert(
            session_id.clone(),
            DapEntry {
                adapter,
                root: canonical,
                conn_id,
                last_activity: Arc::clone(&last_activity),
            },
        );
    }

    // Announce the open DEVICE-WIDE (self-announcing anti-forgery, ADR-0106 D6): every device
    // learns a debug session opened, and the owning cockpit adopts it by `open_id`. A running
    // agent can neither open one nor hide one. The command itself just acks.
    let _ = host.events.send(BridgeEvent::dap_session_opened(
        new_id(),
        now_rfc3339(),
        session_id.clone(),
        adapter_id,
        open_id,
    ));
    spawn_dap_pump(
        Arc::clone(host),
        session_id,
        receiver,
        owner.clone(),
        last_activity,
    );
    Ok(None)
}

/// Spawn the per-session DAP message pump: a std thread draining the adapter's framed-message
/// receiver and routing each frame as a `dap_message` to the OWNING connection ONLY (a DAP frame
/// can carry stack frames and variable / evaluate results, which are the debuggee's runtime
/// memory and potentially secret-bearing, ADR-0106 D7 / D9, so it never reaches another device).
/// When the receiver disconnects (the adapter exited), it asks the reaper to retire the session.
fn spawn_dap_pump(
    host: Arc<Host>,
    session_id: String,
    receiver: std::sync::mpsc::Receiver<serde_json::Value>,
    owner: mpsc::Sender<WireFrame>,
    last_activity: Arc<AtomicU64>,
) {
    std::thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            let frame = server_event_frame(BridgeEvent::dap_message(
                new_id(),
                now_rfc3339(),
                session_id.clone(),
                message,
            ));
            if owner.blocking_send(frame).is_err() {
                break;
            }
            // Stamp AFTER the send so a session actively producing frames but merely backpressured
            // on a slow owner is not mistaken for idle and reaped (ADR-0106 D6).
            last_activity.store(now_millis(), Ordering::Relaxed);
        }
        // The channel disconnected: the adapter exited. Ask the reaper to retire the dead session
        // (announce its close once, drop anything left).
        let _ = host.dap_reaper.send(session_id);
    });
}

/// Enforce the ADR-0106 D3 debuggee boundary on an outbound DAP frame before it reaches the
/// adapter. Under D3 (Firm) the debuggee is **host-resolved**: the client selects a detected
/// `config_id` and the host resolves the program / working directory / arguments; the client
/// never hands over a launch command line. Host-side resolution of a debug configuration per
/// adapter (e.g. locating netcoredbg's built assembly for a `dotnet` config) is not yet designed
/// (ADR-0106 Open-Question-#2), so until it is, the frames that START or re-start a process
/// (`launch` / `restart` / `attach`) are DENIED rather than accepting client-supplied process-start
/// fields. Every other frame (setBreakpoints, continue, stackTrace, variables, evaluate) passes
/// through unchanged. The gate keys on the `command` name, not on `type`, so it is fail-closed: a
/// process-starting command cannot skip it by omitting `type`.
fn gate_dap_request(message: serde_json::Value) -> Result<serde_json::Value, BridgeError> {
    match message.get("command").and_then(serde_json::Value::as_str) {
        Some("launch") | Some("restart") | Some("attach") => Err(BridgeError::new(
            "dap_launch_unimplemented",
            "a host-resolved debug launch is not implemented yet; the client may not supply the \
             debuggee (ADR-0106 D3 / Open-Question-#2)",
        )),
        _ => Ok(message),
    }
}

/// Forward one DAP frame from the owning cockpit to the session's adapter, off the runtime lock
/// (it touches only the DAP map). OWNER-CHECKED (ADR-0106 D6): only the connection that opened a
/// session may drive it. The `launch` request is gated (D3) before it reaches the adapter.
async fn handle_dap_send(
    host: &Arc<Host>,
    session_id: &str,
    message: serde_json::Value,
    conn_id: u64,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    let mut state = host.active_dap.lock().await;
    let Some(entry) = state.sessions.get_mut(session_id) else {
        return Err(BridgeError::new(
            "dap_not_open",
            "no debug session with that id (it may have ended)",
        ));
    };
    if entry.conn_id != conn_id {
        return Err(BridgeError::new(
            "dap_not_owner",
            "that debug session belongs to a different connection",
        ));
    }
    let gated = gate_dap_request(message)?;
    entry.adapter.write_message(&gated)?;
    // Client activity keeps the session alive against the idle watchdog (ADR-0106 D6).
    entry.last_activity.store(now_millis(), Ordering::Relaxed);
    Ok(None)
}

/// Stop a debug session the given connection OWNS (ADR-0106 D6): only the opening connection may
/// stop it. An unknown id is a no-op (idempotent); a foreign id is denied.
async fn stop_dap_session(
    host: &Arc<Host>,
    session_id: &str,
    conn_id: u64,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    {
        let state = host.active_dap.lock().await;
        match state.sessions.get(session_id) {
            Some(entry) if entry.conn_id == conn_id => {}
            Some(_) => {
                return Err(BridgeError::new(
                    "dap_not_owner",
                    "that debug session belongs to a different connection",
                ))
            }
            None => return Ok(None),
        }
    }
    retire_dap(host, session_id, "operator_closed").await;
    Ok(None)
}

/// Retire a debug session: remove it from the map (the mutex, so exactly one path retires and
/// announces a given session) and tear it down.
async fn retire_dap(host: &Arc<Host>, session_id: &str, reason: &str) {
    let removed = host.active_dap.lock().await.sessions.remove(session_id);
    if let Some(entry) = removed {
        kill_dap_entry(&host.events, session_id, entry, reason);
    }
}

/// Tear down a debug session entry we already removed from the map. **Kill first** (the round-3
/// teardown lesson): a best-effort graceful DAP `disconnect` is queued, then the adapter is
/// tree-killed (via `Drop`, which takes the debuggee sharing its process group, D6) on a blocking
/// task BEFORE anything else, so a slow client can never delay enforcement. The `dap_session_closed`
/// announcement is DEVICE-WIDE (self-announcing, D6) on the broadcast bus, whose `send` is
/// non-blocking, so no detached task is needed.
///
/// Honest teardown limitation (ADR-0090 D4): the debuggee is reaped via the adapter's process
/// TREE. On Unix that is `killpg(pgid)`, which reaches the debuggee even if the adapter already
/// exited. On Windows it is `taskkill /PID <adapter> /T`, which walks live parent->child links, so
/// if the ADAPTER dies first (crash) a still-running debuggee child can be orphaned. Binding both
/// processes to a Windows Job Object (or capturing the debuggee pid) is the durable fix and the
/// Slice C follow-up; for Slice A this is a resource-leak edge on Windows, not a containment escape
/// (the debuggee was allowlist-gated in-root at launch, D3).
fn kill_dap_entry(
    events: &broadcast::Sender<BridgeEvent>,
    session_id: &str,
    entry: DapEntry,
    reason: &str,
) {
    let DapEntry { mut adapter, .. } = entry;
    // Best-effort graceful disconnect (non-blocking); the tree-kill below is the guarantee.
    let _ = adapter.write_message(&serde_json::json!({
        "type": "request",
        "command": "disconnect",
        "arguments": { "terminateDebuggee": true }
    }));
    // KILL FIRST: Drop tree-kills the adapter and the debuggee it launched (shared process group).
    tokio::task::spawn_blocking(move || drop(adapter));
    let _ = events.send(BridgeEvent::dap_session_closed(
        new_id(),
        now_rfc3339(),
        session_id.to_string(),
        reason,
    ));
}

/// Handle a terminal input / resize / close off the runtime lock (they touch only the terminals
/// map). Each is OWNER-CHECKED (ADR-0103 D1): only the connection that opened a session may drive
/// it, so a second local cockpit that learned a session id cannot feed, resize, or close it.
async fn handle_terminal_command(
    host: &Arc<Host>,
    command: ClientCommand,
    conn_id: u64,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    use base64::Engine;
    match command {
        ClientCommand::TerminalInput { session_id, data } => {
            // Bound the allocation BEFORE decoding: base64 expands bytes by ~4/3, so a `data`
            // longer than 2x the byte cap cannot decode to something within the cap, so reject it
            // without allocating a decoded buffer for a hostile/huge frame.
            if data.len() > TERMINAL_MAX_INPUT * 2 {
                return Err(BridgeError::new(
                    "terminal_input_too_large",
                    format!("terminal input exceeds the {TERMINAL_MAX_INPUT}-byte cap"),
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|_| {
                    BridgeError::new("terminal_bad_input", "terminal input was not valid base64")
                })?;
            if bytes.len() > TERMINAL_MAX_INPUT {
                return Err(BridgeError::new(
                    "terminal_input_too_large",
                    format!("terminal input exceeds the {TERMINAL_MAX_INPUT}-byte cap"),
                ));
            }
            // `write_input` is a non-blocking queue hand-off (the session's own writer thread
            // does the blocking write), so holding the terminals lock here is O(1).
            let state = host.active_terminals.lock().await;
            let entry = owned_terminal(&state, &session_id, conn_id)?;
            entry.last_activity.store(now_millis(), Ordering::Relaxed);
            entry.session.write_input(&bytes)?;
            Ok(None)
        }
        ClientCommand::TerminalResize {
            session_id,
            cols,
            rows,
        } => {
            let state = host.active_terminals.lock().await;
            let entry = owned_terminal(&state, &session_id, conn_id)?;
            // A resize is interaction too, so it stays the idle watchdog (a user reading a long
            // pager output and only resizing must not be reaped as idle).
            entry.last_activity.store(now_millis(), Ordering::Relaxed);
            entry.session.resize(cols, rows);
            Ok(None)
        }
        ClientCommand::TerminalClose { session_id } => {
            // Only the owner may close a session, so verify ownership before retiring it.
            {
                let state = host.active_terminals.lock().await;
                owned_terminal(&state, &session_id, conn_id)?;
            }
            retire_terminal(host, &session_id, "closed").await;
            Ok(None)
        }
        // Unreachable: the caller only routes the three variants above here.
        _ => Ok(None),
    }
}

/// Look up a terminal the given connection OWNS. Returns `terminal_not_open` for an unknown id,
/// and `terminal_not_owner` if the session exists but a different connection opened it, so a
/// second local cockpit that learned a session id cannot drive it (ADR-0103 D1).
fn owned_terminal<'a>(
    state: &'a TerminalState,
    session_id: &str,
    conn_id: u64,
) -> Result<&'a TerminalEntry, BridgeError> {
    match state.terminals.get(session_id) {
        Some(entry) if entry.conn_id == conn_id => Ok(entry),
        Some(_) => Err(BridgeError::new(
            "terminal_not_owner",
            "that terminal belongs to a different connection",
        )),
        None => Err(terminal_not_open()),
    }
}

/// The error a terminal input/resize gets for an unknown session id (a closed pane), folded
/// by the cockpit into a closed-terminal state rather than surfaced as a hard failure.
fn terminal_not_open() -> BridgeError {
    BridgeError::new("terminal_not_open", "no open terminal for that session id")
}

/// Retire a terminal: remove it from the map, announce its close to the OWNING connection
/// exactly once (if no other path already did), and tree-kill the shell on a blocking task (the
/// Drop kills the tree; the detached reader/writer threads self-terminate when the pty closes).
async fn retire_terminal(host: &Arc<Host>, session_id: &str, reason: &str) {
    let removed = host
        .active_terminals
        .lock()
        .await
        .terminals
        .remove(session_id);
    if let Some(entry) = removed {
        kill_terminal_entry(session_id, entry, reason);
    }
}

/// Tear down a terminal entry we already removed from the map. **Kill first**: the PTY shell is
/// tree-killed (via `Drop`) on a blocking task BEFORE anything touches the owner channel, so a
/// backpressured owner can never delay enforcement (forced close, idle timeout, root removal) while
/// the shell keeps running. The close is announced once (guarded by `closed` so a concurrent
/// pump-exit does not double-announce) on a DETACHED task: reliable delivery so a merely-busy
/// cockpit still learns its shell is gone, but off the caller's teardown loop so a full owner sink
/// cannot stall the idle watchdog or the root-removal sweep. The map removal is the mutex, so
/// exactly one path reaches here for a given session.
fn kill_terminal_entry(session_id: &str, entry: TerminalEntry, reason: &str) {
    let already_closed = entry.closed.swap(true, Ordering::SeqCst);
    let TerminalEntry { session, owner, .. } = entry;
    // KILL FIRST (Drop tree-kills the shell; spawn_blocking keeps the join off the runtime).
    tokio::task::spawn_blocking(move || drop(session));
    if !already_closed {
        let frame = server_event_frame(BridgeEvent::terminal_closed(
            new_id(),
            now_rfc3339(),
            session_id.to_string(),
            reason,
        ));
        tokio::spawn(async move {
            let _ = owner.send(frame).await;
        });
    }
}

/// Spawn the per-session output pump: a std thread draining the PTY's byte channel, base64ing
/// each chunk, and routing it as a `terminal_output` to the OWNING connection ONLY (ADR-0103 D1:
/// Spawn the per-session output pump: a std thread draining the PTY's byte channel, base64ing
/// each chunk, and routing it as a `terminal_output` to the OWNING connection ONLY (ADR-0103 D1:
/// a shell's stream is never delivered to another cockpit). `blocking_send` backpressures the PTY
/// when the owner is slow; a send error means the owner disconnected, so the pump stops. When the
/// channel disconnects (the shell exited), it announces the close once and asks the reaper to
/// drop the dead entry. A std thread (not a tokio task) because the source is a blocking `std::mpsc`.
fn spawn_terminal_pump(
    host: Arc<Host>,
    session_id: String,
    receiver: std::sync::mpsc::Receiver<Vec<u8>>,
    owner: mpsc::Sender<WireFrame>,
    last_activity: Arc<AtomicU64>,
    closed: Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        use base64::Engine;
        while let Ok(chunk) = receiver.recv() {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&chunk);
            let frame = server_event_frame(BridgeEvent::terminal_output(
                new_id(),
                now_rfc3339(),
                session_id.clone(),
                encoded,
            ));
            // Route to the owner. A send error means the owner's socket is gone; stop pumping
            // (the session is swept on that disconnect).
            if owner.blocking_send(frame).is_err() {
                break;
            }
            // Stamp AFTER the send succeeds, so a terminal that is actively producing output but
            // merely backpressured on a slow owner is not mistaken for idle and reaped.
            last_activity.store(now_millis(), Ordering::Relaxed);
        }
        // The channel disconnected: the shell exited (PTY EOF). Announce the close once to the
        // owner, then ask the reaper to drop the dead entry off the terminals map.
        if !closed.swap(true, Ordering::SeqCst) {
            let _ = owner.blocking_send(server_event_frame(BridgeEvent::terminal_closed(
                new_id(),
                now_rfc3339(),
                session_id.clone(),
                "exited",
            )));
        }
        let _ = host.terminal_reaper.send(session_id);
    });
}

/// Stop a launch the given connection OWNS (ADR-0104): only the connection that started a launch
/// may stop it. An unknown id is a no-op (idempotent); a foreign id is denied.
async fn stop_owned_launch(
    host: &Arc<Host>,
    launch_id: &str,
    conn_id: u64,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    {
        let state = host.active_launches.lock().await;
        match state.launches.get(launch_id) {
            Some(entry) if entry.conn_id == conn_id => {}
            Some(_) => {
                return Err(BridgeError::new(
                    "launch_not_owner",
                    "that launch belongs to a different connection",
                ))
            }
            None => return Ok(None),
        }
    }
    retire_launch(host, launch_id, "stopped", None).await;
    Ok(None)
}

/// Park a RELAY launch awaiting the operator's confirmation (ADR-0104 D3, host-enforced): resolve
/// the target now (deny an unknown id before parking), cap the pending queue, then ask the owning
/// connection to confirm. The launch does NOT spawn until the matching `LaunchConfirm` arrives.
async fn park_relay_launch(
    host: &Arc<Host>,
    conn_id: u64,
    owner: &mpsc::Sender<WireFrame>,
    root: String,
    target_id: String,
    open_id: Option<String>,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    let canonical = std::fs::canonicalize(&root)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.clone());
    // Host-owned resolution up front: an unknown id is denied rather than parked (D1).
    if honeyhub_bridge::launch::resolve_target(&canonical, &target_id).is_none() {
        return Err(BridgeError::new(
            "launch_denied",
            format!("no detected launch target '{target_id}' in this project"),
        ));
    }
    let confirm_id = new_id();
    {
        let mut pending = host.pending_launches.lock().await;
        let parked_here = pending.values().filter(|p| p.conn_id == conn_id).count();
        if parked_here >= PENDING_LAUNCH_MAX_PER_CONN {
            return Err(BridgeError::new(
                "launch_limit",
                "too many launches awaiting confirmation; confirm or cancel one first",
            ));
        }
        pending.insert(
            confirm_id.clone(),
            PendingLaunch {
                root: canonical,
                target_id: target_id.clone(),
                conn_id,
                open_id: open_id.clone(),
                created_at: now_millis(),
            },
        );
    }
    let _ = owner
        .send(server_event_frame(BridgeEvent::launch_confirm_required(
            new_id(),
            now_rfc3339(),
            confirm_id,
            target_id,
            open_id,
        )))
        .await;
    Ok(None)
}

/// Confirm a parked relay launch and spawn it (ADR-0104 D3). Only the connection that requested it
/// may confirm; `start_launch` re-resolves the target and re-checks the root atomically, so a root
/// removed between park and confirm still denies the spawn.
async fn confirm_relay_launch(
    host: &Arc<Host>,
    confirm_id: &str,
    conn_id: u64,
    owner: &mpsc::Sender<WireFrame>,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    let pending = {
        let mut map = host.pending_launches.lock().await;
        match map.get(confirm_id) {
            Some(entry) if entry.conn_id == conn_id => map.remove(confirm_id),
            Some(_) => {
                return Err(BridgeError::new(
                    "launch_confirm_denied",
                    "that confirmation belongs to a different connection",
                ))
            }
            None => {
                return Err(BridgeError::new(
                    "launch_confirm_unknown",
                    "no launch is awaiting that confirmation (it may have expired)",
                ))
            }
        }
    };
    let Some(pending) = pending else {
        return Err(BridgeError::new(
            "launch_confirm_unknown",
            "no launch is awaiting that confirmation",
        ));
    };
    start_launch(
        host,
        false,
        conn_id,
        owner,
        pending.root,
        pending.target_id,
        pending.open_id,
    )
    .await
}

/// The configured terminal idle timeout in milliseconds (`0` disables the watchdog).
fn terminal_idle_ms() -> u64 {
    std::env::var(TERMINAL_IDLE_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(TERMINAL_IDLE_DEFAULT_SECS)
        .saturating_mul(1000)
}

/// Gate a command on an allowlisted workspace root, yielding a uniform error keyed by the
/// human-readable `scope` (e.g. "file", "search root", "git root").
fn require(allowed: bool, scope: &str) -> Result<(), BridgeError> {
    if allowed {
        Ok(())
    } else {
        Err(BridgeError::new(
            "workspace_not_allowed",
            format!("{scope} is outside an allowlisted workspace root"),
        ))
    }
}

/// Wrap a single event as the one-event success payload returned by command arms.
fn one(event: BridgeEvent) -> Option<Vec<BridgeEvent>> {
    Some(vec![event])
}

/// Handle a `WriteFile` command: gate the target to an allowlisted root, perform the write,
/// and answer with a `file_written` result plus (on success) fresh `file_contents` so the
/// viewer reflects the save. Extracted from `handle_command` so its nested gate/echo logic
/// doesn't drive that dispatcher's cognitive complexity.
///
/// `workspace_allows` canonicalizes, and canonicalize requires the path to exist — so for a
/// NEW file we gate the parent directory instead (which must exist and be allowlisted). The
/// allowlist gate is a canonicalized starts_with check, so this also blocks `..` escapes out
/// of an allowlisted root.
fn write_file_command(
    runtime: &honeyhub_bridge::BridgeRuntime,
    path: &str,
    content: &str,
) -> Result<Option<Vec<BridgeEvent>>, BridgeError> {
    let target = std::path::Path::new(path);
    let gate = if target.exists() {
        require(runtime.workspace_allows(path), "file")
    } else {
        match target.parent() {
            Some(parent) if parent.exists() => {
                require(runtime.workspace_allows(&parent.to_string_lossy()), "file")
                    .and_then(|()| refuse_symlink_target(target))
            }
            _ => Err(BridgeError::new(
                "workspace_not_allowed",
                "file is outside an allowlisted workspace root",
            )),
        }
    };
    gate.map(|()| {
        let result = honeyhub_bridge::write_file(path, content);
        // Audit the write: path and byte count only, never the content.
        eprintln!(
            "bridge-host: write_file {path} ({} bytes, ok={})",
            content.len(),
            result.ok
        );
        let mut events = vec![BridgeEvent::file_written(
            new_id(),
            now_rfc3339(),
            result.clone(),
        )];
        // On success, re-emit fresh contents so the viewer reflects the save.
        if result.ok {
            if let Ok(file) = honeyhub_bridge::read_file(path) {
                events.push(BridgeEvent::file_contents(new_id(), now_rfc3339(), file));
            }
        }
        events
    })
    .map(Some)
}

/// Refuse to create a NEW file whose final path component is itself a symlink.
///
/// `Path::exists()` (used by [`write_file_command`] to pick the new-file branch) FOLLOWS a
/// symlink, so a **dangling** symlink planted inside an allowlisted root reports "does not
/// exist" and lands in the new-file branch — where `std::fs::write` would then follow the link
/// and write OUTSIDE the root, escaping the allowlist the parent gate just enforced.
/// `symlink_metadata` does NOT follow the link, so it sees the symlink itself and lets us refuse
/// it. A truly-absent path makes `symlink_metadata` error, which is the ordinary new-file case —
/// allow it. (The existing-file branch is already safe: `workspace_allows` canonicalizes and so
/// resolves any symlink, catching an out-of-root target.)
fn refuse_symlink_target(target: &Path) -> Result<(), BridgeError> {
    match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => Err(BridgeError::new(
            "workspace_not_allowed",
            "refusing to create a file through a symlink",
        )),
        _ => Ok(()),
    }
}

/// Build the events for a git write op: a `GitOp` result (success or failure) plus, on
/// success, a fresh `GitStatus` so the cockpit reflects the change immediately. A failed op
/// reports as `GitOp { ok: false }` rather than a transport error, so the UI can show it
/// inline next to the repo.
fn git_write_events(root: &str, op: &str, result: Result<String, BridgeError>) -> Vec<BridgeEvent> {
    match result {
        Ok(message) => {
            let op_event = BridgeEvent::git_op(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::GitOpResult {
                    root: root.to_string(),
                    op: op.to_string(),
                    ok: true,
                    message: if message.is_empty() {
                        None
                    } else {
                        Some(message)
                    },
                },
            );
            match honeyhub_bridge::git_status(root) {
                Ok(status) => vec![
                    op_event,
                    BridgeEvent::git_status(new_id(), now_rfc3339(), status),
                ],
                Err(_) => vec![op_event],
            }
        }
        Err(error) => vec![BridgeEvent::git_op(
            new_id(),
            now_rfc3339(),
            honeyhub_bridge::GitOpResult {
                root: root.to_string(),
                op: op.to_string(),
                ok: false,
                message: Some(error.message),
            },
        )],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- ADR-0106 D3 debuggee boundary: the DAP launch-request gate ----

    #[test]
    fn gate_dap_request_denies_client_launch_and_passes_interactive_frames() {
        // D3 (Firm): the debuggee is host-resolved, never client-supplied. Host-side resolution
        // per adapter is not designed yet (Open-Question-#2), so a client `launch` / `restart` /
        // `attach` (the frames that start a process) is DENIED rather than trusting client fields.
        for command in ["launch", "restart", "attach"] {
            let frame = serde_json::json!({
                "type": "request",
                "command": command,
                "arguments": { "program": "/usr/bin/whoami" }
            });
            let err = gate_dap_request(frame).expect_err("a process-starting frame is denied");
            assert!(
                err.code == "dap_launch_unimplemented" || err.code == "dap_attach_unsupported",
                "{command} is denied, not forwarded: got {}",
                err.code
            );
        }

        // Fail-CLOSED on the command name: a launch that omits `type` is still denied.
        let no_type = serde_json::json!({ "command": "launch", "arguments": { "program": "/x" } });
        assert_eq!(
            gate_dap_request(no_type)
                .expect_err("launch without a type is still denied")
                .code,
            "dap_launch_unimplemented"
        );

        // Interactive frames (stepping, inspection) pass through UNCHANGED: the gate only
        // constrains the frames that start a process.
        for command in [
            "setBreakpoints",
            "continue",
            "next",
            "stackTrace",
            "variables",
            "evaluate",
        ] {
            let frame = serde_json::json!({ "type": "request", "command": command });
            let gated = gate_dap_request(frame.clone()).expect("interactive frame passes");
            assert_eq!(gated, frame);
        }
    }

    #[test]
    fn dap_idle_timeout_defaults_and_bounds_a_stale_session() {
        // With no HONEYHUB_DAP_IDLE_SECS override, the debug idle watchdog uses the 30-minute
        // default (ADR-0106 D6), so a connected cockpit cannot keep an adapter alive forever.
        assert_eq!(dap_idle_ms(), DAP_IDLE_DEFAULT_SECS * 1000);
        assert!(dap_idle_ms() > 0, "the idle watchdog is enabled by default");

        // The reaper's expiry predicate (mirrored here): a session whose last activity is older
        // than the timeout is expired, while one that just had traffic is not.
        let idle_ms = dap_idle_ms();
        let now = now_millis();
        let stale = now.saturating_sub(idle_ms + 1_000);
        let fresh = now;
        assert!(
            now.saturating_sub(stale) > idle_ms,
            "a stale session is reaped"
        );
        assert!(
            now.saturating_sub(fresh) <= idle_ms,
            "an active session survives"
        );
    }

    #[test]
    fn initialize_coalescing_forwards_once_and_answers_the_rest() {
        // LSP allows exactly one initialize per server. With a server shared across
        // cockpits: the first initialize forwards; a second arriving WHILE the first is
        // in flight is coalesced (queued, not forwarded); once the result caches, a later
        // initialize is answered from the cache.
        let mut state = LspState::default();
        let key = LspKey::new(&std::env::temp_dir().to_string_lossy(), "typescript");
        let id_a = serde_json::json!("a-0");
        let id_b = serde_json::json!("b-0");
        let id_c = serde_json::json!("c-0");

        // First cockpit: forwarded, its id recorded as the pending initialize.
        assert_eq!(
            state.on_initialize(&key, Some(id_a.clone())),
            InitDecision::Forward
        );
        assert_eq!(state.pending_init.get(&key), Some(&id_a));

        // Second cockpit while the first is still in flight: coalesced, queued as a waiter,
        // NOT forwarded.
        assert_eq!(
            state.on_initialize(&key, Some(id_b.clone())),
            InitDecision::Coalesced
        );
        assert_eq!(
            state.init_waiters.get(&key).map(Vec::as_slice),
            Some(&[id_b][..])
        );

        // The first result caches (as the pump does on the initialize response).
        let result = serde_json::json!({ "capabilities": { "hoverProvider": true } });
        state.init_results.insert(key.clone(), result.clone());

        // A later cockpit is now answered from the cache, not forwarded.
        assert_eq!(
            state.on_initialize(&key, Some(id_c)),
            InitDecision::ReplyCached(result)
        );

        // Retiring the server clears all initialize tracking, so a restart re-initializes.
        state.servers.clear();
        state.take_server(&key);
        assert!(state.pending_init.is_empty());
        assert!(state.init_waiters.is_empty());
        assert!(state.init_results.is_empty());
        assert_eq!(state.on_initialize(&key, Some(id_a)), InitDecision::Forward);
    }

    /// Best-effort symlink creation. On Windows, creating a symlink needs a privilege (or
    /// Developer Mode); when that is unavailable this returns `false` so the caller can skip the
    /// symlink-specific assertion rather than fail on an environment limitation.
    fn try_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    // Regression: a dangling symlink planted in an allowlisted root must not become a write path
    // out of the root. `Path::exists()` follows the link, so a dangling one reaches the new-file
    // branch; `refuse_symlink_target` uses `symlink_metadata` (which does NOT follow) to catch it.
    #[test]
    fn refuse_symlink_target_blocks_dangling_symlink_but_allows_absent_and_regular() {
        let root = std::env::temp_dir().join(format!("honeyhub-wf-{}", new_id()));
        std::fs::create_dir_all(&root).expect("temp allowlisted root is created");

        // An ordinary absent path is the normal new-file case — allowed.
        let absent = root.join("brand-new.txt");
        assert!(refuse_symlink_target(&absent).is_ok());

        // A regular existing file (created directly, not through a link) — allowed.
        let regular = root.join("regular.txt");
        std::fs::write(&regular, b"hi").expect("regular file is written");
        assert!(refuse_symlink_target(&regular).is_ok());

        // A DANGLING symlink inside the root whose target is OUTSIDE the root: `exists()` follows
        // the link and reports false, but writing through it would escape the root — refuse it.
        let outside = std::env::temp_dir().join(format!("honeyhub-escape-{}.txt", new_id()));
        let link = root.join("looks-new.txt");
        if try_symlink(&outside, &link) {
            assert!(
                !link.exists(),
                "the planted symlink is dangling (its target does not exist)"
            );
            let refused =
                refuse_symlink_target(&link).expect_err("a dangling symlink target is refused");
            assert_eq!(refused.code, "workspace_not_allowed");
        }

        let _ = std::fs::remove_dir_all(&root);
    }
}
