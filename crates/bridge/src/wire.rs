use crate::adapter::{BridgeError, StartRunRequest};
use crate::session::{
    DispatchControlEvent, DispatchMessage, DispatchRunState, PolicyHint, UsageSignal,
};
use serde::{Deserialize, Serialize};

pub const WIRE_PROTOCOL_VERSION: &str = "honeyhub.bridge.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFrameKind {
    ClientCommand,
    ServerEvent,
    Ack,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFrame {
    pub protocol: String,
    pub frame_id: String,
    pub kind: WireFrameKind,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<ClientCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<BridgeEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack_frame_id: Option<String>,
}

impl WireFrame {
    pub fn server_event(
        frame_id: impl Into<String>,
        event: BridgeEvent,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::ServerEvent,
            created_at: created_at.into(),
            command: None,
            event: Some(event),
            error: None,
            ack_frame_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClientCommand {
    Start { request: Box<StartRunRequest> },
    Reply { run_id: String, text: String },
    Stop { run_id: String },
    Resume { session_id_or_transcript: String },
    Reconnect { request: ReconnectRequest },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectRequest {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeEvent {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub created_at: String,
    pub payload: BridgeEventPayload,
}

impl BridgeEvent {
    pub fn status(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        status: BridgeStatusEvent,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Status { status },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeEventPayload {
    Message { message: DispatchMessage },
    Control { event: DispatchControlEvent },
    Usage { signal: UsageSignal },
    PolicyHint { hint: PolicyHint },
    Status { status: BridgeStatusEvent },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusEvent {
    pub state: DispatchRunState,
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_versioned_server_event_frame() {
        let event = BridgeEvent::status(
            "event-1",
            "session-1",
            "run-1",
            1,
            "2026-06-07T12:00:00Z",
            BridgeStatusEvent {
                state: DispatchRunState::Running,
                backend: "claude.local".to_string(),
                repo_hint: Some("HoneyDrunk.HoneyHub".to_string()),
                link: None,
            },
        );
        let frame = WireFrame::server_event("frame-1", event, "2026-06-07T12:00:00Z");

        assert_eq!(
            serde_json::to_value(frame).expect("frame serializes"),
            json!({
                "protocol": "honeyhub.bridge.v1",
                "frameId": "frame-1",
                "kind": "server_event",
                "createdAt": "2026-06-07T12:00:00Z",
                "event": {
                    "id": "event-1",
                    "sessionId": "session-1",
                    "runId": "run-1",
                    "sequence": 1,
                    "createdAt": "2026-06-07T12:00:00Z",
                    "payload": {
                        "kind": "status",
                        "status": {
                            "state": "running",
                            "backend": "claude.local",
                            "repoHint": "HoneyDrunk.HoneyHub"
                        }
                    }
                }
            })
        );
    }
}
