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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use honeyhub_bridge::clock::now_rfc3339;
use honeyhub_bridge::{BridgeError, BridgeEvent, ClientCommand, PairingRegistry, WireFrame};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::services::ServeDir;

/// Default poll cadence for draining the runtime's event stream.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Shared host state: the runtime (single-writer behind an async mutex), the set
/// of runs still worth polling, and a broadcast of events to every client.
struct Host {
    runtime: Mutex<honeyhub_bridge::BridgeRuntime>,
    active_runs: Mutex<std::collections::HashSet<String>>,
    events: broadcast::Sender<BridgeEvent>,
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
) -> std::io::Result<()> {
    let (events_tx, _events_rx) = broadcast::channel::<BridgeEvent>(1024);
    let host = Arc::new(Host {
        runtime: Mutex::new(runtime),
        active_runs: Mutex::new(std::collections::HashSet::new()),
        events: events_tx,
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

    let state = AppState {
        host,
        registry: Arc::new(registry),
    };
    let mut app = Router::new().route("/ws", get(ws_handler));
    if let Some(dir) = static_dir {
        app = app.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    }
    let app = app.with_state(state);

    axum::serve(listener, app.into_make_service()).await
}

async fn ws_handler(
    upgrade: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
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
    upgrade.on_upgrade(move |socket| handle_socket(socket, state.host))
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
        }
    }
}

async fn handle_socket(socket: WebSocket, host: Arc<Host>) {
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
            handle_command(&host, command, &frame.frame_id, &outbound_tx).await;
        }
    }

    writer.abort();
}

async fn handle_command(
    host: &Arc<Host>,
    command: ClientCommand,
    frame_id: &str,
    outbound_tx: &mpsc::Sender<WireFrame>,
) {
    let mut to_register: Option<String> = None;
    let result: Result<Option<Vec<BridgeEvent>>, BridgeError> = {
        let mut runtime = host.runtime.lock().await;
        match command {
            ClientCommand::Start { request } => match runtime.start(*request, now_rfc3339()) {
                Ok(handle) => {
                    to_register = Some(handle.run_id);
                    Ok(None)
                }
                Err(error) => Err(error),
            },
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
            ClientCommand::DiscoverAgents { workspace_root } => {
                match runtime.discover_agents(workspace_root.as_deref()) {
                    Ok(agents) => Ok(Some(vec![BridgeEvent::agent_catalog(
                        new_id(),
                        now_rfc3339(),
                        agents,
                    )])),
                    Err(error) => Err(error),
                }
            }
            ClientCommand::DiscoverBackends => Ok(Some(vec![BridgeEvent::backend_catalog(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::detect_default_backends(),
            )])),
            ClientCommand::SetWorkspaceRoots { roots } => {
                runtime.set_workspace_roots(roots);
                Ok(None)
            }
            ClientCommand::BrowseDir { path } => {
                match honeyhub_bridge::browse_dir(path.as_deref()) {
                    Ok(listing) => Ok(Some(vec![BridgeEvent::dir_listing(
                        new_id(),
                        now_rfc3339(),
                        listing,
                    )])),
                    Err(error) => Err(error),
                }
            }
            ClientCommand::ReadFile { path } => {
                // Gate file *contents* to the user's allowlisted roots (browse lists
                // names unscoped, but reading content requires an added root).
                if !runtime.workspace_allows(&path) {
                    Err(BridgeError::new(
                        "workspace_not_allowed",
                        "file is outside an allowlisted workspace root",
                    ))
                } else {
                    match honeyhub_bridge::read_file(&path) {
                        Ok(file) => Ok(Some(vec![BridgeEvent::file_contents(
                            new_id(),
                            now_rfc3339(),
                            file,
                        )])),
                        Err(error) => Err(error),
                    }
                }
            }
            ClientCommand::ResolveWorkspaceFile { path } => {
                // Unscoped like browse: the user selects a .code-workspace to *add* its
                // repos as roots, so it must be readable before those roots exist. It
                // only reads the small workspace JSON (folder paths), not repo contents.
                match honeyhub_bridge::resolve_workspace_file(&path) {
                    Ok(folders) => Ok(Some(vec![BridgeEvent::workspace_folders(
                        new_id(),
                        now_rfc3339(),
                        folders,
                    )])),
                    Err(error) => Err(error),
                }
            }
            ClientCommand::SearchFiles { root, query } => {
                // Search is gated to an allowlisted root (it reads the tree there).
                if !runtime.workspace_allows(&root) {
                    Err(BridgeError::new(
                        "workspace_not_allowed",
                        "search root is outside an allowlisted workspace root",
                    ))
                } else {
                    match honeyhub_bridge::search_files(&root, &query) {
                        Ok(results) => Ok(Some(vec![BridgeEvent::search_results(
                            new_id(),
                            now_rfc3339(),
                            results,
                        )])),
                        Err(error) => Err(error),
                    }
                }
            }
            ClientCommand::WriteAgent {
                name,
                description,
                body,
                model,
                workspace_root,
            } => match runtime.write_agent(
                workspace_root.as_deref(),
                &name,
                &description,
                &body,
                model.as_deref(),
            ) {
                Ok(agent) => Ok(Some(vec![BridgeEvent::agent_written(
                    new_id(),
                    now_rfc3339(),
                    agent,
                )])),
                Err(error) => Err(error),
            },
            ClientCommand::ListJobs {
                extra_probes,
                extra_task_keywords,
            } => match honeyhub_bridge::job_snapshot(&extra_probes, &extra_task_keywords) {
                Ok(snapshot) => Ok(Some(vec![BridgeEvent::job_snapshot(
                    new_id(),
                    now_rfc3339(),
                    snapshot,
                )])),
                Err(error) => Err(error),
            },
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
            ClientCommand::PeekServiceBus {
                namespace,
                entity,
                subscription,
                dead_letter,
                count,
            } => Ok(Some(vec![BridgeEvent::service_bus_peek(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_peek(
                    &namespace,
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
                    count,
                ),
            )])),
            ClientCommand::ResubmitDeadLetter {
                namespace,
                entity,
                subscription,
                count,
            } => Ok(Some(vec![BridgeEvent::service_bus_resubmit(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_resubmit(
                    &namespace,
                    &entity,
                    subscription.as_deref(),
                    count,
                ),
            )])),
            ClientCommand::PurgeServiceBus {
                namespace,
                entity,
                subscription,
                dead_letter,
            } => Ok(Some(vec![BridgeEvent::service_bus_purge(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_purge(
                    &namespace,
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
                ),
            )])),
            ClientCommand::SendServiceBus {
                namespace,
                entity,
                body,
                subject,
                content_type,
            } => Ok(Some(vec![BridgeEvent::service_bus_send(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_send(
                    &namespace,
                    &entity,
                    &body,
                    subject.as_deref(),
                    content_type.as_deref(),
                ),
            )])),
            ClientCommand::ReceiveServiceBus {
                namespace,
                entity,
                subscription,
                dead_letter,
            } => Ok(Some(vec![BridgeEvent::service_bus_receive(
                new_id(),
                now_rfc3339(),
                honeyhub_bridge::service_bus_receive(
                    &namespace,
                    &entity,
                    subscription.as_deref(),
                    dead_letter,
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
                if !runtime.workspace_allows(&root) {
                    Err(BridgeError::new(
                        "workspace_not_allowed",
                        "git root is outside an allowlisted workspace root",
                    ))
                } else {
                    match honeyhub_bridge::git_status(&root) {
                        Ok(status) => Ok(Some(vec![BridgeEvent::git_status(
                            new_id(),
                            now_rfc3339(),
                            status,
                        )])),
                        Err(error) => Err(error),
                    }
                }
            }
            ClientCommand::GitDiff { root, path } => {
                if !runtime.workspace_allows(&root) {
                    Err(BridgeError::new(
                        "workspace_not_allowed",
                        "git root is outside an allowlisted workspace root",
                    ))
                } else {
                    match honeyhub_bridge::git_diff(&root, path.as_deref()) {
                        Ok(diff) => Ok(Some(vec![BridgeEvent::git_diff(
                            new_id(),
                            now_rfc3339(),
                            diff,
                        )])),
                        Err(error) => Err(error),
                    }
                }
            }
            ClientCommand::ListSessions => Ok(Some(vec![BridgeEvent::session_list(
                new_id(),
                now_rfc3339(),
                runtime.stored_sessions(),
            )])),
            ClientCommand::SessionDetail { session_id } => {
                let (runs, transcript) = runtime.stored_session_detail(&session_id);
                Ok(Some(vec![BridgeEvent::session_detail(
                    new_id(),
                    now_rfc3339(),
                    session_id,
                    runs,
                    transcript,
                )]))
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
                match honeyhub_bridge::scaffold_architecture(
                    name.as_deref(),
                    location.as_deref(),
                    &roots,
                ) {
                    Ok(snapshot) => Ok(Some(vec![BridgeEvent::roadmap(
                        new_id(),
                        now_rfc3339(),
                        snapshot,
                    )])),
                    Err(error) => Err(error),
                }
            }
            ClientCommand::PullArchitecture => {
                let roots = runtime.workspace_roots();
                match honeyhub_bridge::pull_architecture(&roots) {
                    Ok(snapshot) => Ok(Some(vec![BridgeEvent::roadmap(
                        new_id(),
                        now_rfc3339(),
                        snapshot,
                    )])),
                    Err(error) => Err(error),
                }
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
