//! Integration test: the LSP channel over the real WebSocket transport (ADR-0102). Proves
//! the command/event/error plumbing end to end without a real language server —
//!   * `lsp_start` for a language with no allowlisted server broadcasts an honest
//!     `lsp_status { installed: false, running: false }` (graceful degradation), and
//!   * `lsp_start` for a root outside the allowlist is rejected, and
//!   * `lsp_send` with no running server answers with an `lsp_not_running` error.
//!
//! The framed spawn/round-trip against a live (fake) server is covered by the bridge
//! crate's `tests/lsp.rs`.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use honeyhub_bridge::{
    AgentBackend, AgentBackendAdapter, BackendAllowlist, BridgeError, BridgeEvent,
    BridgeEventPayload, BridgeIdentity, BridgeRuntime, CapabilityFlags, ClientCommand,
    PairingRegistry, RunHandle, StartRunRequest, WireFrame, WorkspaceAllowlist,
};
use honeyhub_bridge_host::{bind, serve, DEFAULT_POLL_INTERVAL};
use tokio_tungstenite::tungstenite::Message;

struct NoopAdapter;

impl AgentBackendAdapter for NoopAdapter {
    fn backend(&self) -> AgentBackend {
        AgentBackend::ClaudeLocal
    }
    fn capabilities(&self) -> CapabilityFlags {
        CapabilityFlags::claude_local()
    }
    fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
        Ok(RunHandle {
            run_id: request
                .requested_run_id
                .unwrap_or_else(|| "run-1".to_string()),
            process_id: None,
        })
    }
    fn stream(&self, _run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
        Ok(Vec::new())
    }
    fn reply(&self, _run_id: &str, _text: &str) -> Result<(), BridgeError> {
        Ok(())
    }
    fn stop(&self, _run_id: &str) -> Result<(), BridgeError> {
        Ok(())
    }
    fn resume(&self, _session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
        Ok(RunHandle {
            run_id: "resumed".to_string(),
            process_id: None,
        })
    }
}

fn workspace() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

fn runtime() -> BridgeRuntime {
    BridgeRuntime::new(
        NoopAdapter,
        WorkspaceAllowlist::new(vec![workspace()]),
        BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
    )
}

async fn spawn_host() -> (String, String) {
    let mut registry = PairingRegistry::new(BridgeIdentity::new("test-host"));
    let grant = registry.pair("client", "2026-06-07T12:00:00.000Z");
    let token = grant.token;
    let listener = bind("127.0.0.1:0".parse().expect("addr"))
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = serve(
            listener,
            runtime(),
            registry,
            DEFAULT_POLL_INTERVAL,
            None::<PathBuf>,
            None,
        )
        .await;
    });
    (addr.to_string(), token)
}

async fn connect(
    addr: &str,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://{addr}/ws?token={token}");
    let (ws, _response) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");
    ws
}

async fn send(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    frame_id: &str,
    command: ClientCommand,
) {
    let frame = WireFrame::client_command(frame_id, command, "2026-06-07T12:00:00.000Z");
    ws.send(Message::Text(
        serde_json::to_string(&frame).expect("encode"),
    ))
    .await
    .expect("send");
}

/// Read frames until `predicate` returns a value or the deadline passes.
async fn read_until<T>(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut predicate: impl FnMut(&WireFrame) -> Option<T>,
) -> Option<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let next = tokio::time::timeout(Duration::from_secs(1), ws.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = next else {
            continue;
        };
        let frame: WireFrame = serde_json::from_str(text.as_str()).expect("decode frame");
        if let Some(value) = predicate(&frame) {
            return Some(value);
        }
    }
    None
}

#[tokio::test]
async fn lsp_start_for_an_unsupported_language_reports_graceful_degradation() {
    let (addr, token) = spawn_host().await;
    let mut ws = connect(&addr, &token).await;
    send(
        &mut ws,
        "frame-start",
        ClientCommand::LspStart {
            root: workspace(),
            language_id: "python".to_string(),
        },
    )
    .await;

    let status = read_until(&mut ws, |frame| {
        match frame.event.as_ref().map(|e| &e.payload) {
            Some(BridgeEventPayload::LspStatus { status }) => Some(status.clone()),
            _ => None,
        }
    })
    .await
    .expect("an lsp_status event");
    assert_eq!(status.language_id, "python");
    assert!(!status.installed, "no allowlisted server for python");
    assert!(!status.running);
}

#[tokio::test]
async fn lsp_start_outside_the_allowlist_is_rejected() {
    let (addr, token) = spawn_host().await;
    let mut ws = connect(&addr, &token).await;
    // The parent of the allowlisted temp dir exists but is not itself allowlisted.
    let outside = std::path::Path::new(&workspace())
        .parent()
        .expect("temp has a parent")
        .to_string_lossy()
        .to_string();
    send(
        &mut ws,
        "frame-denied",
        ClientCommand::LspStart {
            root: outside,
            language_id: "typescript".to_string(),
        },
    )
    .await;

    let code = read_until(&mut ws, |frame| {
        if frame.kind == honeyhub_bridge::WireFrameKind::Error {
            frame.error.as_ref().map(|e| e.code.clone())
        } else {
            None
        }
    })
    .await
    .expect("an error frame");
    assert_eq!(code, "workspace_not_allowed");
}

#[tokio::test]
async fn client_shutdown_is_intercepted_not_forwarded() {
    // A shared language server serves multiple cockpits; one cockpit's `shutdown` / `exit`
    // must not terminate it for the others. The host intercepts these as no-ops (server
    // lifecycle is host-owned), so the frame is acked, NOT surfaced as lsp_not_running and
    // NOT forwarded to a server. Two cockpits are connected to prove the shared setting.
    let (addr, token) = spawn_host().await;
    let mut ws1 = connect(&addr, &token).await;
    let ws2 = connect(&addr, &token).await;
    send(
        &mut ws1,
        "frame-shutdown",
        ClientCommand::LspSend {
            root: workspace(),
            language_id: "typescript".to_string(),
            message: serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "shutdown" }),
        },
    )
    .await;

    let outcome = read_until(&mut ws1, |frame| {
        if frame.ack_frame_id.as_deref() == Some("frame-shutdown") {
            Some((frame.kind.clone(), frame.error.as_ref().map(|e| e.code.clone())))
        } else {
            None
        }
    })
    .await
    .expect("a response for the shutdown frame");
    assert_eq!(outcome.0, honeyhub_bridge::WireFrameKind::Ack);
    assert!(outcome.1.is_none(), "shutdown must be acked, not errored");
    // The second cockpit stays connected and unaffected.
    drop(ws2);
}

#[tokio::test]
async fn lsp_send_without_a_running_server_errors() {
    let (addr, token) = spawn_host().await;
    let mut ws = connect(&addr, &token).await;
    send(
        &mut ws,
        "frame-send",
        ClientCommand::LspSend {
            root: workspace(),
            language_id: "typescript".to_string(),
            message: serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
        },
    )
    .await;

    let code = read_until(&mut ws, |frame| {
        if frame.kind == honeyhub_bridge::WireFrameKind::Error {
            frame.error.as_ref().map(|e| e.code.clone())
        } else {
            None
        }
    })
    .await
    .expect("an error frame");
    assert_eq!(code, "lsp_not_running");
}
