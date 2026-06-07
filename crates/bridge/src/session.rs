use crate::adapter::AgentBackend;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchRunState {
    Created,
    Queued,
    Starting,
    Running,
    NeedsInput,
    Finalizing,
    Completed,
    Stopping,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageFidelity {
    Exact,
    Derived,
    Estimated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyHintSeverity {
    Info,
    Warning,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchMessageRole {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchControlEventKind {
    StateChanged,
    Launch,
    Reply,
    Stop,
    Resume,
    Approve,
    Reject,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSession {
    pub id: String,
    pub backend: AgentBackend,
    pub title: String,
    pub workspace_root: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRun {
    pub id: String,
    pub session_id: String,
    pub state: DispatchRunState,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchMessage {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub role: DispatchMessageRole,
    pub body: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_partial: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchControlEvent {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: DispatchControlEventKind,
    pub created_at: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSignal {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub backend: AgentBackend,
    pub fidelity: UsageFidelity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premium_requests: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<UsageConfidence>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyHint {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub code: String,
    pub severity: PolicyHintSeverity,
    pub message: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_session_contract_with_frontend_wire_names() {
        let session = DispatchSession {
            id: "session-1".to_string(),
            backend: AgentBackend::ClaudeLocal,
            title: "HoneyHub scaffold".to_string(),
            workspace_root: "C:/work".to_string(),
            created_at: "2026-06-07T12:00:00Z".to_string(),
            updated_at: "2026-06-07T12:00:00Z".to_string(),
            current_run_id: None,
        };

        assert_eq!(
            serde_json::to_value(session).expect("session serializes"),
            json!({
                "id": "session-1",
                "backend": "claude.local",
                "title": "HoneyHub scaffold",
                "workspaceRoot": "C:/work",
                "createdAt": "2026-06-07T12:00:00Z",
                "updatedAt": "2026-06-07T12:00:00Z"
            })
        );
    }

    #[test]
    fn serializes_message_and_control_event_as_typed_contracts() {
        let message = DispatchMessage {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            role: DispatchMessageRole::Agent,
            body: "Ready".to_string(),
            created_at: "2026-06-07T12:01:00Z".to_string(),
            is_partial: Some(false),
        };
        let event = DispatchControlEvent {
            id: "event-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            kind: DispatchControlEventKind::StateChanged,
            created_at: "2026-06-07T12:01:01Z".to_string(),
            summary: "Run started".to_string(),
        };

        assert_eq!(
            serde_json::to_value(message).expect("message serializes"),
            json!({
                "id": "message-1",
                "sessionId": "session-1",
                "runId": "run-1",
                "role": "agent",
                "body": "Ready",
                "createdAt": "2026-06-07T12:01:00Z",
                "isPartial": false
            })
        );
        assert_eq!(
            serde_json::to_value(event).expect("event serializes"),
            json!({
                "id": "event-1",
                "sessionId": "session-1",
                "runId": "run-1",
                "kind": "state_changed",
                "createdAt": "2026-06-07T12:01:01Z",
                "summary": "Run started"
            })
        );
    }

    #[test]
    fn serializes_usage_and_policy_contracts_with_optional_fields() {
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            backend: AgentBackend::CodexLocal,
            fidelity: UsageFidelity::Estimated,
            model_label: Some("codex-latest".to_string()),
            input_tokens: Some(120),
            output_tokens: Some(40),
            total_tokens: Some(160),
            total_usd: None,
            premium_requests: Some(1),
            duration_ms: Some(2500),
            confidence: Some(UsageConfidence::Medium),
            recorded_at: "2026-06-07T12:02:00Z".to_string(),
        };
        let hint = PolicyHint {
            id: "hint-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: None,
            code: "local_only".to_string(),
            severity: PolicyHintSeverity::Warning,
            message: "Keep execution local".to_string(),
            created_at: "2026-06-07T12:02:01Z".to_string(),
        };

        assert_eq!(
            serde_json::to_value(usage).expect("usage serializes"),
            json!({
                "id": "usage-1",
                "sessionId": "session-1",
                "runId": "run-1",
                "backend": "codex.local",
                "fidelity": "estimated",
                "modelLabel": "codex-latest",
                "inputTokens": 120,
                "outputTokens": 40,
                "totalTokens": 160,
                "premiumRequests": 1,
                "durationMs": 2500,
                "confidence": "medium",
                "recordedAt": "2026-06-07T12:02:00Z"
            })
        );
        assert_eq!(
            serde_json::to_value(hint).expect("hint serializes"),
            json!({
                "id": "hint-1",
                "sessionId": "session-1",
                "code": "local_only",
                "severity": "warning",
                "message": "Keep execution local",
                "createdAt": "2026-06-07T12:02:01Z"
            })
        );
    }
}
