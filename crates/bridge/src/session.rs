#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsageFidelity {
    Exact,
    Derived,
    Estimated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchSession {
    pub id: String,
    pub backend: String,
    pub title: String,
    pub workspace_root: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchRun {
    pub id: String,
    pub session_id: String,
    pub state: DispatchRunState,
    pub task: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchMessage {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub role: String,
    pub body: String,
    pub created_at: String,
    pub is_partial: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchControlEvent {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: String,
    pub created_at: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageSignal {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub backend: String,
    pub fidelity: UsageFidelity,
    pub model_label: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub total_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub recorded_at: String,
}
