use crate::adapter::{AgentBackend, BridgeError};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
    FollowUp,
    Stop,
    Resume,
    ProcessExit,
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

/// A per-`(backend, fidelity)` rollup of usage across many turns. Backends with
/// different usage fidelity (`exact` / `derived` / `estimated`) are kept in
/// **separate** rollups so the spend view never sums a measured cost together with
/// an estimate (ADR-0092 D2: each usage figure is load-bearing only with its
/// fidelity attached).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRollup {
    pub backend: AgentBackend,
    pub fidelity: UsageFidelity,
    /// Number of usage signals (billed turns) folded into this rollup.
    pub turn_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    /// Summed USD across this rollup's signals that carried a cost. `None` when no
    /// signal in the group reported USD — an `estimated` backend never does, and a
    /// `derived` backend with no rate table wired does not either (USD is never
    /// fabricated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usd: Option<f64>,
    /// Summed premium requests (the real billing unit for `estimated` backends like
    /// Copilot). `None` when no signal in the group reported a premium-request count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premium_requests: Option<u64>,
    pub duration_ms: u64,
}

/// A device-wide "your spend" summary: usage rolled up per `(backend, fidelity)`,
/// plus a **grounded** USD total that deliberately excludes estimated spend.
/// Cross-session and local-only (ADR-0092 D1/D2) — nothing here syncs off-device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// Distinct sessions that contributed at least one run (supplied by the caller,
    /// which knows the session set; the aggregator only sees signals).
    pub session_count: u64,
    /// Total billed turns across every rollup.
    pub total_turns: u64,
    pub rollups: Vec<UsageRollup>,
    /// Sum of USD across **exact + derived** rollups only — a real dollar figure.
    /// Estimated backends (Copilot bills premium requests, not a token cost) are
    /// excluded so a guess can never inflate the headline spend. `None` when no
    /// grounded signal reported USD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounded_total_usd: Option<f64>,
    /// Total premium requests across estimated backends — surfaced separately from
    /// the grounded dollar figure, never folded into it.
    pub total_premium_requests: u64,
}

impl UsageSummary {
    /// Aggregate raw usage signals into a device-wide summary. Pure over its inputs
    /// (the caller supplies the distinct `session_count`) so it is testable without a
    /// store or a runtime, and shared by every producer of a summary (the live
    /// runtime today; the persistent store when it is wired in). Rollups are ordered
    /// deterministically by `(backend, fidelity)`.
    pub fn from_signals(signals: &[UsageSignal], session_count: u64) -> Self {
        use std::collections::BTreeMap;
        let mut groups: BTreeMap<(AgentBackend, UsageFidelity), UsageRollup> = BTreeMap::new();
        for signal in signals {
            let rollup = groups
                .entry((signal.backend.clone(), signal.fidelity.clone()))
                .or_insert_with(|| UsageRollup {
                    backend: signal.backend.clone(),
                    fidelity: signal.fidelity.clone(),
                    turn_count: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    total_usd: None,
                    premium_requests: None,
                    duration_ms: 0,
                });
            rollup.turn_count += 1;
            rollup.input_tokens += signal.input_tokens.unwrap_or(0);
            rollup.output_tokens += signal.output_tokens.unwrap_or(0);
            rollup.total_tokens += signal.total_tokens.unwrap_or(0);
            if let Some(usd) = signal.total_usd {
                rollup.total_usd = Some(rollup.total_usd.unwrap_or(0.0) + usd);
            }
            if let Some(premium) = signal.premium_requests {
                rollup.premium_requests = Some(rollup.premium_requests.unwrap_or(0) + premium);
            }
            rollup.duration_ms += signal.duration_ms.unwrap_or(0);
        }

        let rollups: Vec<UsageRollup> = groups.into_values().collect();
        let total_turns = rollups.iter().map(|rollup| rollup.turn_count).sum();
        let is_grounded = |rollup: &&UsageRollup| {
            matches!(
                rollup.fidelity,
                UsageFidelity::Exact | UsageFidelity::Derived
            )
        };
        // Headline spend sums grounded USD only; `None` (not `0.00`) when no grounded
        // signal carried a cost, so the UI can distinguish "no spend recorded" from
        // "spend that genuinely rounds to zero".
        let any_grounded_usd = rollups
            .iter()
            .filter(is_grounded)
            .any(|rollup| rollup.total_usd.is_some());
        let grounded_total_usd = any_grounded_usd.then(|| {
            rollups
                .iter()
                .filter(is_grounded)
                .filter_map(|rollup| rollup.total_usd)
                .sum()
        });
        let total_premium_requests = rollups
            .iter()
            .filter_map(|rollup| rollup.premium_requests)
            .sum();

        Self {
            session_count,
            total_turns,
            rollups,
            grounded_total_usd,
            total_premium_requests,
        }
    }
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

impl DispatchRunState {
    pub fn can_transition_to(&self, next: &Self) -> bool {
        matches!(
            (self, next),
            (Self::Created, Self::Queued)
                | (Self::Created, Self::Failed)
                | (Self::Created, Self::Cancelled)
                | (Self::Queued, Self::Starting)
                | (Self::Queued, Self::Failed)
                | (Self::Queued, Self::Cancelled)
                | (Self::Starting, Self::Running)
                | (Self::Starting, Self::NeedsInput)
                | (Self::Starting, Self::Stopping)
                | (Self::Starting, Self::Failed)
                | (Self::Starting, Self::Cancelled)
                | (Self::Running, Self::NeedsInput)
                | (Self::Running, Self::Finalizing)
                | (Self::Running, Self::Stopping)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::Cancelled)
                | (Self::NeedsInput, Self::Running)
                | (Self::NeedsInput, Self::Finalizing)
                | (Self::NeedsInput, Self::Stopping)
                | (Self::NeedsInput, Self::Failed)
                | (Self::NeedsInput, Self::Cancelled)
                | (Self::Finalizing, Self::Completed)
                | (Self::Finalizing, Self::Failed)
                | (Self::Finalizing, Self::Cancelled)
                | (Self::Stopping, Self::Failed)
                | (Self::Stopping, Self::Cancelled)
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

impl DispatchRun {
    pub fn new(
        id: impl Into<String>,
        session_id: impl Into<String>,
        task: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            state: DispatchRunState::Created,
            task: task.into(),
            started_at: None,
            completed_at: None,
            failure_reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRunRecord {
    pub run: DispatchRun,
    pub control_events: Vec<DispatchControlEvent>,
}

impl DispatchRunRecord {
    pub fn new(run: DispatchRun) -> Self {
        Self {
            run,
            control_events: Vec::new(),
        }
    }

    pub fn transition_to(
        &mut self,
        next: DispatchRunState,
        created_at: impl Into<String>,
    ) -> Result<DispatchControlEvent, BridgeError> {
        let created_at = created_at.into();
        if !self.run.state.can_transition_to(&next) {
            return Err(BridgeError::new(
                "invalid_state_transition",
                format!(
                    "cannot transition run {} from {:?} to {:?}",
                    self.run.id, self.run.state, next
                ),
            ));
        }

        let previous = self.run.state.clone();
        self.run.state = next.clone();
        if matches!(
            next,
            DispatchRunState::Running | DispatchRunState::NeedsInput
        ) && self.run.started_at.is_none()
        {
            self.run.started_at = Some(created_at.clone());
        }
        if next.is_terminal() {
            self.run.completed_at = Some(created_at.clone());
        }

        self.append_event(
            DispatchControlEventKind::StateChanged,
            created_at,
            format!("state: {:?} -> {:?}", previous, next),
        )
    }

    pub fn append_event(
        &mut self,
        kind: DispatchControlEventKind,
        created_at: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<DispatchControlEvent, BridgeError> {
        let event = DispatchControlEvent {
            id: Uuid::new_v4().to_string(),
            session_id: self.run.session_id.clone(),
            run_id: self.run.id.clone(),
            kind,
            created_at: created_at.into(),
            summary: summary.into(),
        };
        self.control_events.push(event.clone());
        Ok(event)
    }
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
    fn rejects_invalid_transition_without_silent_noop() {
        let mut record =
            DispatchRunRecord::new(DispatchRun::new("run-1", "session-1", "build bridge core"));

        record
            .transition_to(DispatchRunState::Queued, "2026-06-07T12:00:00Z")
            .expect("created can queue");
        let error = record
            .transition_to(DispatchRunState::Completed, "2026-06-07T12:00:01Z")
            .expect_err("queued cannot complete directly");

        assert_eq!(error.code, "invalid_state_transition");
        assert_eq!(record.run.state, DispatchRunState::Queued);
        assert_eq!(record.control_events.len(), 1);
    }

    #[test]
    fn completion_requires_finalizing_state() {
        let mut record =
            DispatchRunRecord::new(DispatchRun::new("run-1", "session-1", "build bridge core"));
        record
            .transition_to(DispatchRunState::Queued, "2026-06-07T12:00:00Z")
            .expect("created can queue");
        record
            .transition_to(DispatchRunState::Starting, "2026-06-07T12:00:01Z")
            .expect("queued can start");
        record
            .transition_to(DispatchRunState::Running, "2026-06-07T12:00:02Z")
            .expect("starting can run");

        let error = record
            .transition_to(DispatchRunState::Completed, "2026-06-07T12:00:03Z")
            .expect_err("running cannot complete directly");

        assert_eq!(error.code, "invalid_state_transition");
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

    fn usage(
        backend: AgentBackend,
        fidelity: UsageFidelity,
        tokens: u64,
        usd: Option<f64>,
        premium: Option<u64>,
        duration: u64,
    ) -> UsageSignal {
        UsageSignal {
            id: "u".to_string(),
            session_id: "s".to_string(),
            run_id: "r".to_string(),
            backend,
            fidelity,
            model_label: None,
            input_tokens: Some(tokens / 2),
            output_tokens: Some(tokens / 2),
            total_tokens: Some(tokens),
            total_usd: usd,
            premium_requests: premium,
            duration_ms: Some(duration),
            confidence: None,
            recorded_at: "2026-06-07T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn usage_summary_keeps_fidelities_separate_and_grounds_only_measured_usd() {
        let signals = vec![
            // Two exact (claude) turns: tokens and USD sum within the rollup.
            usage(
                AgentBackend::ClaudeLocal,
                UsageFidelity::Exact,
                100,
                Some(0.10),
                None,
                1000,
            ),
            usage(
                AgentBackend::ClaudeLocal,
                UsageFidelity::Exact,
                60,
                Some(0.05),
                None,
                500,
            ),
            // One derived (codex) turn with USD — also grounded.
            usage(
                AgentBackend::CodexLocal,
                UsageFidelity::Derived,
                40,
                Some(0.02),
                None,
                300,
            ),
            // One estimated (copilot) turn: premium requests, no USD — excluded from
            // the grounded dollar total.
            usage(
                AgentBackend::CopilotLocal,
                UsageFidelity::Estimated,
                20,
                None,
                Some(1),
                1800,
            ),
        ];

        let summary = UsageSummary::from_signals(&signals, 3);

        assert_eq!(summary.session_count, 3);
        assert_eq!(summary.total_turns, 4);
        // Grounded = exact (0.10 + 0.05) + derived (0.02); estimated is excluded.
        // USD is summed in f64, so compare within a cent's worth of epsilon rather
        // than bit-exact (0.10 + 0.05 does not round-trip exactly in binary float).
        let grounded = summary.grounded_total_usd.expect("grounded usd present");
        assert!((grounded - 0.17).abs() < 1e-9, "grounded was {grounded}");
        assert_eq!(summary.total_premium_requests, 1);

        // Rollups are ordered deterministically by (backend, fidelity).
        assert_eq!(summary.rollups.len(), 3);
        let claude = &summary.rollups[0];
        assert_eq!(claude.backend, AgentBackend::ClaudeLocal);
        assert_eq!(claude.fidelity, UsageFidelity::Exact);
        assert_eq!(claude.turn_count, 2);
        assert_eq!(claude.total_tokens, 160);
        let claude_usd = claude.total_usd.expect("claude usd present");
        assert!(
            (claude_usd - 0.15).abs() < 1e-9,
            "claude usd was {claude_usd}"
        );
        assert_eq!(claude.duration_ms, 1500);

        let copilot = &summary.rollups[2];
        assert_eq!(copilot.backend, AgentBackend::CopilotLocal);
        assert_eq!(copilot.fidelity, UsageFidelity::Estimated);
        // Estimated rollup carries premium requests but no USD.
        assert_eq!(copilot.total_usd, None);
        assert_eq!(copilot.premium_requests, Some(1));
    }

    #[test]
    fn usage_summary_grounded_usd_is_none_when_no_measured_cost() {
        // Estimated-only activity: there is no grounded dollar figure to report, and
        // the headline must stay `None` rather than collapse to a misleading 0.00.
        let signals = vec![usage(
            AgentBackend::CopilotLocal,
            UsageFidelity::Estimated,
            20,
            None,
            Some(2),
            900,
        )];

        let summary = UsageSummary::from_signals(&signals, 1);

        assert_eq!(summary.grounded_total_usd, None);
        assert_eq!(summary.total_premium_requests, 2);
        assert_eq!(summary.total_turns, 1);
    }

    #[test]
    fn usage_summary_is_empty_for_no_signals() {
        let summary = UsageSummary::from_signals(&[], 0);
        assert!(summary.rollups.is_empty());
        assert_eq!(summary.total_turns, 0);
        assert_eq!(summary.grounded_total_usd, None);
        assert_eq!(summary.total_premium_requests, 0);
    }
}
