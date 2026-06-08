//! Integration test: a real WebSocket client connects to the host, authenticates
//! with a pairing token, sends a `start` command, and receives the streamed
//! events — proving the transport carries the wire protocol end to end. A bad
//! token is rejected at the handshake.

use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use honeyhub_bridge::wire::BridgeStatusEvent;
use honeyhub_bridge::{
    AgentBackend, AgentBackendAdapter, BackendAllowlist, BridgeError, BridgeEvent,
    BridgeEventPayload, BridgeIdentity, BridgeRuntime, CapabilityFlags, ClientCommand,
    DispatchMessage, DispatchMessageRole, DispatchRunState, DispatchSession, PairingRegistry,
    RunHandle, StartRunRequest, WireFrame,
};
use honeyhub_bridge_host::{bind, serve, DEFAULT_POLL_INTERVAL};
use tokio_tungstenite::tungstenite::Message;

struct ScriptedAdapter {
    emitted: Mutex<bool>,
}

impl ScriptedAdapter {
    fn new() -> Self {
        Self {
            emitted: Mutex::new(false),
        }
    }
}

impl AgentBackendAdapter for ScriptedAdapter {
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
            process_id: Some(4321),
        })
    }

    fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
        let mut emitted = self.emitted.lock().expect("lock");
        if *emitted {
            return Ok(Vec::new());
        }
        *emitted = true;
        Ok(vec![
            BridgeEvent::message(
                "event-msg",
                "session-1",
                run_id,
                0,
                "2026-06-07T12:00:00.000Z",
                DispatchMessage {
                    id: "m1".to_string(),
                    session_id: "session-1".to_string(),
                    run_id: run_id.to_string(),
                    role: DispatchMessageRole::Agent,
                    body: "hello from the bridge".to_string(),
                    created_at: "2026-06-07T12:00:00.000Z".to_string(),
                    is_partial: Some(false),
                },
            ),
            BridgeEvent::status(
                "event-status",
                "session-1",
                run_id,
                1,
                "2026-06-07T12:00:01.000Z",
                BridgeStatusEvent {
                    state: DispatchRunState::NeedsInput,
                    backend: AgentBackend::ClaudeLocal,
                    repo_hint: None,
                    link: None,
                },
            ),
        ])
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

fn runtime() -> BridgeRuntime<ScriptedAdapter> {
    BridgeRuntime::new(
        ScriptedAdapter::new(),
        honeyhub_bridge::WorkspaceAllowlist::new(vec![workspace()]),
        BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
    )
}

fn session() -> DispatchSession {
    DispatchSession {
        id: "session-1".to_string(),
        backend: AgentBackend::ClaudeLocal,
        title: "host test".to_string(),
        workspace_root: workspace(),
        created_at: "2026-06-07T12:00:00.000Z".to_string(),
        updated_at: "2026-06-07T12:00:00.000Z".to_string(),
        current_run_id: None,
    }
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
        let _ = serve(listener, runtime(), registry, DEFAULT_POLL_INTERVAL).await;
    });
    (addr.to_string(), token)
}

#[tokio::test]
async fn streams_events_to_an_authenticated_client() {
    let (addr, token) = spawn_host().await;
    let url = format!("ws://{addr}/?token={token}");
    let (mut ws, _response) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");

    let start = WireFrame::client_command(
        "frame-start",
        ClientCommand::Start {
            request: Box::new(StartRunRequest {
                session: session(),
                workspace_root: workspace(),
                task: "do the thing".to_string(),
                requested_run_id: Some("run-1".to_string()),
                follow_up_to_run_id: None,
                transcript: Vec::new(),
                launch_command: None,
            }),
        },
        "2026-06-07T12:00:00.000Z",
    );
    ws.send(Message::Text(
        serde_json::to_string(&start).expect("encode"),
    ))
    .await
    .expect("send start");

    // Collect frames until we see the agent message + needs_input status.
    let mut saw_message = false;
    let mut saw_needs_input = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while (!saw_message || !saw_needs_input) && tokio::time::Instant::now() < deadline {
        let next = tokio::time::timeout(Duration::from_secs(1), ws.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = next else {
            continue;
        };
        let frame: WireFrame = serde_json::from_str(text.as_str()).expect("decode frame");
        if let Some(event) = frame.event {
            match event.payload {
                BridgeEventPayload::Message { message }
                    if message.body == "hello from the bridge" =>
                {
                    saw_message = true;
                }
                BridgeEventPayload::Status { status }
                    if status.state == DispatchRunState::NeedsInput =>
                {
                    saw_needs_input = true;
                }
                _ => {}
            }
        }
    }

    assert!(saw_message, "expected the streamed agent message");
    assert!(saw_needs_input, "expected the needs_input status");
}

#[tokio::test]
async fn rejects_an_invalid_pairing_token() {
    let (addr, _token) = spawn_host().await;
    let url = format!("ws://{addr}/?token=not-a-real-token");
    let result = tokio_tungstenite::connect_async(url).await;
    assert!(result.is_err(), "handshake must reject an unknown token");
}
