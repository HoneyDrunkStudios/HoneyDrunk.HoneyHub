use crate::session::{DispatchMessage, DispatchSession};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentBackend {
    ClaudeLocal,
    CodexLocal,
    CopilotLocal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityFlags {
    pub streaming_output: bool,
    pub interactive_reply: bool,
    pub resume_session: bool,
    pub stop_signal: bool,
    pub structured_events: bool,
    pub usage_exact: bool,
    pub usage_estimated: bool,
}

impl CapabilityFlags {
    pub fn claude_local() -> Self {
        Self {
            streaming_output: true,
            interactive_reply: true,
            resume_session: true,
            stop_signal: true,
            structured_events: true,
            usage_exact: true,
            usage_estimated: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRunRequest {
    pub session: DispatchSession,
    pub workspace_root: String,
    pub task: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHandle {
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub trait AgentBackendAdapter {
    fn backend(&self) -> AgentBackend;
    fn capabilities(&self) -> CapabilityFlags;
    fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError>;
    fn stream(&self, run_id: &str) -> Result<Vec<DispatchMessage>, BridgeError>;
    fn reply(&self, run_id: &str, text: &str) -> Result<(), BridgeError>;
    fn stop(&self, run_id: &str) -> Result<(), BridgeError>;
    fn resume(&self, session_id_or_transcript: &str) -> Result<RunHandle, BridgeError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeClaudeAdapter;

    impl AgentBackendAdapter for FakeClaudeAdapter {
        fn backend(&self) -> AgentBackend {
            AgentBackend::ClaudeLocal
        }

        fn capabilities(&self) -> CapabilityFlags {
            CapabilityFlags::claude_local()
        }

        fn start(&self, _request: StartRunRequest) -> Result<RunHandle, BridgeError> {
            Ok(RunHandle {
                run_id: "run-1".to_string(),
            })
        }

        fn stream(&self, _run_id: &str) -> Result<Vec<DispatchMessage>, BridgeError> {
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
                run_id: "run-2".to_string(),
            })
        }
    }

    #[test]
    fn fake_adapter_declares_claude_capabilities() {
        let adapter = FakeClaudeAdapter;
        let capabilities = adapter.capabilities();

        assert!(capabilities.streaming_output);
        assert!(capabilities.interactive_reply);
        assert!(capabilities.usage_exact);
        assert!(!capabilities.usage_estimated);
    }
}
