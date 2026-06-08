use crate::adapter::{AgentBackend, BridgeError, StartRunRequest};
use crate::artifact::DispatchArtifact;
use crate::session::{
    DispatchControlEvent, DispatchMessage, DispatchRunState, PolicyHint, UsageSignal, UsageSummary,
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

    pub fn client_command(
        frame_id: impl Into<String>,
        command: ClientCommand,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::ClientCommand,
            created_at: created_at.into(),
            command: Some(command),
            event: None,
            error: None,
            ack_frame_id: None,
        }
    }

    pub fn ack(
        frame_id: impl Into<String>,
        ack_frame_id: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::Ack,
            created_at: created_at.into(),
            command: None,
            event: None,
            error: None,
            ack_frame_id: Some(ack_frame_id.into()),
        }
    }

    pub fn error(
        frame_id: impl Into<String>,
        error: BridgeError,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::Error,
            created_at: created_at.into(),
            command: None,
            event: None,
            error: Some(error),
            ack_frame_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClientCommand {
    Start {
        request: Box<StartRunRequest>,
    },
    Reply {
        run_id: String,
        text: String,
    },
    Stop {
        run_id: String,
    },
    Resume {
        session_id_or_transcript: String,
    },
    Reconnect {
        request: ReconnectRequest,
    },
    /// Request the device-wide "your spend" summary (ADR-0092 D2 cost view). A
    /// read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::UsageSummary`] server event followed by an ack.
    UsageSummary,
    /// Request the cross-session coaching advisories (ADR-0092 D4 / packet 09 §3e).
    /// A read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::CoachingHints`] server event followed by an ack.
    CoachingHints,
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

    pub fn message(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        message: DispatchMessage,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Message { message },
        }
    }

    pub fn control(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        event: DispatchControlEvent,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Control { event },
        }
    }

    pub fn usage(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        signal: UsageSignal,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Usage { signal },
        }
    }

    pub fn policy_hint(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        hint: PolicyHint,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::PolicyHint { hint },
        }
    }

    pub fn artifact(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        artifact: DispatchArtifact,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Artifact { artifact },
        }
    }

    /// A device-wide usage summary event. It is **not** scoped to a single run or
    /// session (it aggregates across all of them), so `session_id`/`run_id` are
    /// empty and `sequence` is `0`; the client dispatches on the payload kind.
    pub fn usage_summary(
        id: impl Into<String>,
        created_at: impl Into<String>,
        summary: UsageSummary,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::UsageSummary { summary },
        }
    }

    /// A device-wide coaching-advisories event. Like the usage summary it spans every
    /// session (each hint carries its own `session_id`), so the envelope's
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn coaching_hints(
        id: impl Into<String>,
        created_at: impl Into<String>,
        hints: Vec<PolicyHint>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::CoachingHints { hints },
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
    Artifact { artifact: DispatchArtifact },
    UsageSummary { summary: UsageSummary },
    CoachingHints { hints: Vec<PolicyHint> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusEvent {
    pub state: DispatchRunState,
    pub backend: AgentBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::AgentBackend;
    use crate::artifact::ArtifactKind;
    use crate::session::{
        DispatchControlEventKind, DispatchMessageRole, DispatchSession, PolicyHintSeverity,
        UsageConfidence, UsageFidelity,
    };
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
                backend: AgentBackend::ClaudeLocal,
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

    #[test]
    fn serializes_artifact_server_event_frame() {
        let event = BridgeEvent::artifact(
            "event-2",
            "session-1",
            "run-1",
            2,
            "2026-06-07T12:00:00Z",
            DispatchArtifact {
                id: "artifact-1".to_string(),
                session_id: "session-1".to_string(),
                run_id: "run-1".to_string(),
                kind: ArtifactKind::PullRequest,
                label: "Open PR".to_string(),
                href: Some("https://example.test/pr/1".to_string()),
                repo_relative_path: None,
                created_at: "2026-06-07T12:00:00Z".to_string(),
            },
        );
        let frame = WireFrame::server_event("frame-2", event, "2026-06-07T12:00:00Z");

        assert_eq!(
            serde_json::to_value(frame).expect("frame serializes"),
            json!({
                "protocol": "honeyhub.bridge.v1",
                "frameId": "frame-2",
                "kind": "server_event",
                "createdAt": "2026-06-07T12:00:00Z",
                "event": {
                    "id": "event-2",
                    "sessionId": "session-1",
                    "runId": "run-1",
                    "sequence": 2,
                    "createdAt": "2026-06-07T12:00:00Z",
                    "payload": {
                        "kind": "artifact",
                        "artifact": {
                            "id": "artifact-1",
                            "sessionId": "session-1",
                            "runId": "run-1",
                            "kind": "pull_request",
                            "label": "Open PR",
                            "href": "https://example.test/pr/1",
                            "createdAt": "2026-06-07T12:00:00Z"
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn serializes_client_command_fields_as_camel_case() {
        let command = ClientCommand::Resume {
            session_id_or_transcript: "session-1".to_string(),
        };

        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({
                "kind": "resume",
                "sessionIdOrTranscript": "session-1"
            })
        );
    }

    #[test]
    fn serializes_usage_summary_query_as_fieldless_tagged_command() {
        // The query carries no payload; it must serialize as just the tag so the
        // client can send a bare `{"kind":"usage_summary"}` (snake_case, per the
        // enum's `rename_all`).
        let command = ClientCommand::UsageSummary;
        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({ "kind": "usage_summary" })
        );
    }

    #[test]
    fn serializes_coaching_hints_query_as_fieldless_tagged_command() {
        let command = ClientCommand::CoachingHints;
        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({ "kind": "coaching_hints" })
        );
    }

    #[test]
    fn round_trips_wire_frames_and_payload_variants() {
        let created_at = "2026-06-07T12:00:00Z";
        let message = DispatchMessage {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            role: DispatchMessageRole::Agent,
            body: "hello, \"HoneyHub\"".to_string(),
            created_at: created_at.to_string(),
            is_partial: Some(false),
        };
        let control = DispatchControlEvent {
            id: "control-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            kind: DispatchControlEventKind::Reply,
            created_at: created_at.to_string(),
            summary: "reply accepted".to_string(),
        };
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity: UsageFidelity::Estimated,
            model_label: Some("claude".to_string()),
            input_tokens: Some(0),
            output_tokens: Some(0),
            total_tokens: Some(0),
            total_usd: None,
            premium_requests: None,
            duration_ms: Some(0),
            confidence: Some(UsageConfidence::Low),
            recorded_at: created_at.to_string(),
        };
        let hint = PolicyHint {
            id: "hint-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            code: "empty-field".to_string(),
            severity: PolicyHintSeverity::Info,
            message: "".to_string(),
            created_at: created_at.to_string(),
        };
        let frames = vec![
            WireFrame::client_command(
                "frame-start",
                ClientCommand::Start {
                    request: Box::new(StartRunRequest {
                        session: DispatchSession {
                            id: "session-1".to_string(),
                            backend: AgentBackend::ClaudeLocal,
                            title: "Bridge".to_string(),
                            workspace_root: "C:/work/honeyhub".to_string(),
                            created_at: created_at.to_string(),
                            updated_at: created_at.to_string(),
                            current_run_id: None,
                        },
                        workspace_root: "C:/work/honeyhub".to_string(),
                        task: "run with emoji-safe text: <>&".to_string(),
                        requested_run_id: Some("run-1".to_string()),
                        follow_up_to_run_id: None,
                        transcript: Vec::new(),
                        launch_command: None,
                    }),
                },
                created_at,
            ),
            WireFrame::server_event(
                "frame-message",
                BridgeEvent::message(
                    "event-message",
                    "session-1",
                    "run-1",
                    1,
                    created_at,
                    message,
                ),
                created_at,
            ),
            WireFrame::server_event(
                "frame-control",
                BridgeEvent::control(
                    "event-control",
                    "session-1",
                    "run-1",
                    2,
                    created_at,
                    control,
                ),
                created_at,
            ),
            WireFrame::server_event(
                "frame-usage",
                BridgeEvent::usage("event-usage", "session-1", "run-1", 3, created_at, usage),
                created_at,
            ),
            WireFrame::server_event(
                "frame-hint",
                BridgeEvent::policy_hint("event-hint", "session-1", "run-1", 4, created_at, hint),
                created_at,
            ),
            WireFrame::server_event(
                "frame-artifact",
                BridgeEvent::artifact(
                    "event-artifact",
                    "session-1",
                    "run-1",
                    5,
                    created_at,
                    DispatchArtifact {
                        id: "artifact-1".to_string(),
                        session_id: "session-1".to_string(),
                        run_id: "run-1".to_string(),
                        kind: ArtifactKind::Branch,
                        label: "feature/x".to_string(),
                        href: None,
                        repo_relative_path: Some("crates/bridge".to_string()),
                        created_at: created_at.to_string(),
                    },
                ),
                created_at,
            ),
            WireFrame::client_command(
                "frame-reply",
                ClientCommand::Reply {
                    run_id: "run-1".to_string(),
                    text: "special chars: \n\t\"".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-stop",
                ClientCommand::Stop {
                    run_id: "run-1".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-resume",
                ClientCommand::Resume {
                    session_id_or_transcript: "session-1".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-reconnect",
                ClientCommand::Reconnect {
                    request: ReconnectRequest {
                        session_id: "session-1".to_string(),
                        run_id: Some("run-1".to_string()),
                        last_event_id: Some("event-4".to_string()),
                    },
                },
                created_at,
            ),
            WireFrame::client_command("frame-usage-query", ClientCommand::UsageSummary, created_at),
            WireFrame::server_event(
                "frame-usage-summary",
                BridgeEvent::usage_summary(
                    "event-usage-summary",
                    created_at,
                    crate::session::UsageSummary::from_signals(
                        &[UsageSignal {
                            id: "u1".to_string(),
                            session_id: "session-1".to_string(),
                            run_id: "run-1".to_string(),
                            backend: AgentBackend::ClaudeLocal,
                            fidelity: UsageFidelity::Exact,
                            model_label: None,
                            input_tokens: Some(10),
                            output_tokens: Some(5),
                            total_tokens: Some(15),
                            total_usd: Some(0.01),
                            premium_requests: None,
                            duration_ms: Some(100),
                            confidence: None,
                            recorded_at: created_at.to_string(),
                        }],
                        1,
                    ),
                ),
                created_at,
            ),
            WireFrame::client_command(
                "frame-coaching-query",
                ClientCommand::CoachingHints,
                created_at,
            ),
            WireFrame::server_event(
                "frame-coaching-hints",
                BridgeEvent::coaching_hints(
                    "event-coaching-hints",
                    created_at,
                    vec![PolicyHint {
                        id: "coach:session-1:stale_session".to_string(),
                        session_id: "session-1".to_string(),
                        run_id: Some("run-1".to_string()),
                        code: "stale_session".to_string(),
                        severity: PolicyHintSeverity::Warning,
                        message: "This session is large.".to_string(),
                        created_at: created_at.to_string(),
                    }],
                ),
                created_at,
            ),
            WireFrame::ack("frame-ack", "frame-reply", created_at),
            WireFrame::error(
                "frame-error",
                BridgeError::new("bad_request", "invalid frame"),
                created_at,
            ),
        ];

        for frame in frames {
            let value = serde_json::to_value(&frame).expect("frame serializes");
            let round_trip: WireFrame = serde_json::from_value(value).expect("frame deserializes");
            assert_eq!(round_trip, frame);
        }
    }
}
