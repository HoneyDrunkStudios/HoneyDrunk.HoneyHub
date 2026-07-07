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
    /// Monotonic source of per-connection ids, so a launch (or terminal) can be tied to the
    /// socket that opened it and swept when that socket disconnects.
    next_conn_id: AtomicU64,
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
        roots: honeyhub_bridge::WorkspaceAllowlist::new(initial_roots),
        ..LaunchState::default()
    };
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
        next_conn_id: AtomicU64::new(0),
    });

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
    // A content search validated under the runtime lock but executed after it is released
    // (grepping a big tree is slow filesystem work; holding the runtime lock through it
    // would stall every other client command).
    let mut search_job: Option<(String, String, honeyhub_bridge::ContentSearchOptions)> = None;
    // A launch gated under the runtime lock (root allowlist + host-owned target resolution) but
    // SPAWNED after it is released: spawning a process is blocking work that must not stall the
    // poll loop. Carries (local, root, target_id, open_id).
    let mut launch_job: Option<(bool, String, String, Option<String>)> = None;
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
    // Retire any de-authorized launches off-lock: announce the stop to the OWNING connection,
    // then tree-kill the process group on a blocking task. Each was already removed from the map
    // under the launches lock, so exactly one path announces its stop.
    for (launch_id, entry) in launch_orphans {
        let _ = entry
            .owner
            .send(server_event_frame(BridgeEvent::launch_stopped(
                new_id(),
                now_rfc3339(),
                launch_id,
                "root_removed",
                None,
            )))
            .await;
        tokio::task::spawn_blocking(move || drop(entry.session));
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

/// Retire a launch: remove it from the map, announce its stop to the OWNING connection, and
/// tree-kill the process group on a blocking task (Drop kills the tree). The map removal is the
/// mutex: whichever path removes an entry announces its stop, and a second path finds it already
/// gone, so the stop is announced exactly once. `exit_code` is the process exit code on the
/// natural-exit path (from the watchdog), and `None` when the launch was killed.
async fn retire_launch(host: &Arc<Host>, launch_id: &str, reason: &str, exit_code: Option<i32>) {
    let removed = host.active_launches.lock().await.launches.remove(launch_id);
    if let Some(entry) = removed {
        let _ = entry
            .owner
            .send(server_event_frame(BridgeEvent::launch_stopped(
                new_id(),
                now_rfc3339(),
                launch_id.to_string(),
                reason,
                exit_code,
            )))
            .await;
        tokio::task::spawn_blocking(move || drop(entry.session));
    }
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

/// Gate a command on an allowlisted workspace root, yielding a uniform error
/// keyed by the human-readable `scope` (e.g. "file", "search root", "git root").
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
