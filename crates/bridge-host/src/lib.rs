//! HoneyHub bridge host — exposes a `BridgeRuntime` to the PWA over the
//! `honeyhub.bridge.v1` wire protocol on a local WebSocket.
//!
//! This is the transport that connects the browser cockpit to the Rust bridge
//! (ADR-0091 D2/D5: the desktop shell hosts the bridge on localhost; mobile
//! reaches the same host over a Tailscale tailnet). The transport mechanism is
//! `[Provisional]` (ADR-0091 D5 / packet-04 README) — a localhost WebSocket here;
//! it can move to Tauri IPC for the bundled-desktop case without changing the
//! wire contract or the PWA's `WireClient` seam.
//!
//! A client presents its pairing token (packet 05) as the `token` query parameter
//! on the WebSocket URL; an unknown or revoked token is rejected at the handshake.
//! After that, the client sends `ClientCommand` frames and receives `server_event`
//! frames carrying `BridgeEvent`s. The host polls the runtime's pull-based stream
//! on an interval and broadcasts new events to all connected clients.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use honeyhub_bridge::clock::now_rfc3339;
use honeyhub_bridge::{
    AgentBackendAdapter, BridgeError, BridgeEvent, ClientCommand, PairingRegistry, WireFrame,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

/// Default poll cadence for draining the runtime's event stream.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Shared host state: the runtime (single-writer behind an async mutex), the set
/// of runs still worth polling, and a broadcast of events to every client.
struct Host<A: AgentBackendAdapter> {
    runtime: Mutex<honeyhub_bridge::BridgeRuntime<A>>,
    active_runs: Mutex<HashSet<String>>,
    events: broadcast::Sender<BridgeEvent>,
}

/// Extract the `token` query parameter from a WebSocket upgrade request.
fn token_from_request(request: &Request) -> Option<String> {
    let query = request.uri().query()?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key == "token" {
            Some(value.to_string())
        } else {
            None
        }
    })
}

/// Bind a listener for the host. Returns the listener so callers (and tests) can
/// read the actually-bound address before serving.
pub async fn bind(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr).await
}

/// Serve the bridge over the given listener until it errors. Connections are
/// authenticated against `registry`; `runtime` drives the backend.
pub async fn serve<A>(
    listener: TcpListener,
    runtime: honeyhub_bridge::BridgeRuntime<A>,
    registry: PairingRegistry,
    poll_interval: Duration,
) -> std::io::Result<()>
where
    A: AgentBackendAdapter + Send + 'static,
{
    let (events_tx, _events_rx) = broadcast::channel::<BridgeEvent>(1024);
    let host = Arc::new(Host {
        runtime: Mutex::new(runtime),
        active_runs: Mutex::new(HashSet::new()),
        events: events_tx,
    });
    let registry = Arc::new(registry);

    // Polling task: drain each active run's stream and broadcast new events.
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

    loop {
        let (stream, _peer) = listener.accept().await?;
        let host = Arc::clone(&host);
        let registry = Arc::clone(&registry);
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, host, registry).await {
                eprintln!("bridge-host: connection ended: {error}");
            }
        });
    }
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
                // Stop polling this run, but say why rather than dropping it
                // silently (e.g. the run was removed, or the adapter errored).
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

// The auth callback must return `Result<Response, ErrorResponse>` — a type
// dictated by tokio-tungstenite's handshake API, so the large-Err lint does not
// apply to a signature we control.
#[allow(clippy::result_large_err)]
async fn handle_connection<A>(
    stream: TcpStream,
    host: Arc<Host<A>>,
    registry: Arc<PairingRegistry>,
) -> Result<(), tokio_tungstenite::tungstenite::Error>
where
    A: AgentBackendAdapter + Send + 'static,
{
    // Authenticate at the handshake: the pairing token rides the `token` query
    // parameter; an unknown/revoked token is rejected before any frame flows.
    let auth_registry = Arc::clone(&registry);
    let ws = tokio_tungstenite::accept_hdr_async(
        stream,
        move |request: &Request, response: Response| {
            let token = token_from_request(request);
            let authorized = token
                .as_deref()
                .map(|token| auth_registry.is_authorized(token))
                .unwrap_or(false);
            if authorized {
                Ok(response)
            } else {
                let mut error =
                    ErrorResponse::new(Some("unauthorized: invalid pairing token".to_string()));
                *error.status_mut() = StatusCode::UNAUTHORIZED;
                Err(error)
            }
        },
    )
    .await?;

    let (mut ws_sink, mut ws_stream) = ws.split();
    let mut events_rx = host.events.subscribe();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<WireFrame>(256);

    // Writer: server events (broadcast) + per-connection acks/errors/replays.
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                event = events_rx.recv() => {
                    match event {
                        Ok(event) => {
                            let frame = WireFrame::server_event(new_id(), event, now_rfc3339());
                            if send_frame(&mut ws_sink, &frame).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                frame = outbound_rx.recv() => {
                    match frame {
                        Some(frame) => {
                            if send_frame(&mut ws_sink, &frame).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Reader: parse client commands and drive the runtime.
    while let Some(message) = ws_stream.next().await {
        let message = message?;
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {
                continue
            }
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
    Ok(())
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
            ClientCommand::Resume { .. } => Err(BridgeError::new(
                "unsupported_command",
                "resume is not driven by the host runtime yet",
            )),
        }
    };

    // Insert into the active set after releasing the runtime lock (poll never
    // holds both locks at once, so there is no lock-ordering hazard).
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
            // correlate it to the command it sent and surface the failure
            // (e.g. a disallowed workspace root or backend).
            let mut error_frame = WireFrame::error(new_id(), error, now_rfc3339());
            error_frame.ack_frame_id = Some(frame_id.to_string());
            let _ = outbound_tx.send(error_frame).await;
        }
    }
}

async fn send_frame<S>(
    sink: &mut S,
    frame: &WireFrame,
) -> Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let text = serde_json::to_string(frame).map_err(|error| {
        tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error,
        ))
    })?;
    sink.send(Message::Text(text)).await
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
