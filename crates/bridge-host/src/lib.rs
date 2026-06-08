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
use honeyhub_bridge::{
    AgentBackendAdapter, BridgeError, BridgeEvent, ClientCommand, PairingRegistry, WireFrame,
};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::services::ServeDir;

/// Default poll cadence for draining the runtime's event stream.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Shared host state: the runtime (single-writer behind an async mutex), the set
/// of runs still worth polling, and a broadcast of events to every client.
struct Host<A: AgentBackendAdapter> {
    runtime: Mutex<honeyhub_bridge::BridgeRuntime<A>>,
    active_runs: Mutex<std::collections::HashSet<String>>,
    events: broadcast::Sender<BridgeEvent>,
}

struct AppState<A: AgentBackendAdapter> {
    host: Arc<Host<A>>,
    registry: Arc<PairingRegistry>,
}

impl<A: AgentBackendAdapter> Clone for AppState<A> {
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
pub async fn serve<A>(
    listener: TcpListener,
    runtime: honeyhub_bridge::BridgeRuntime<A>,
    registry: PairingRegistry,
    poll_interval: Duration,
    static_dir: Option<PathBuf>,
) -> std::io::Result<()>
where
    A: AgentBackendAdapter + Send + 'static,
{
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
    let mut app = Router::new().route("/ws", get(ws_handler::<A>));
    if let Some(dir) = static_dir {
        app = app.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    }
    let app = app.with_state(state);

    axum::serve(listener, app.into_make_service()).await
}

async fn ws_handler<A>(
    upgrade: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState<A>>,
) -> Response
where
    A: AgentBackendAdapter + Send + 'static,
{
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

async fn poll_active_runs<A: AgentBackendAdapter>(host: &Arc<Host<A>>) {
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

async fn handle_socket<A: AgentBackendAdapter + Send + 'static>(
    socket: WebSocket,
    host: Arc<Host<A>>,
) {
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

async fn handle_command<A: AgentBackendAdapter>(
    host: &Arc<Host<A>>,
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
