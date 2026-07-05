use crate::session::{DispatchMessage, DispatchSession};
use crate::wire::BridgeEvent;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AgentBackend {
    #[serde(rename = "claude.local")]
    ClaudeLocal,
    #[serde(rename = "codex.local")]
    CodexLocal,
    #[serde(rename = "copilot.local")]
    CopilotLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityFlags {
    pub streaming_output: bool,
    pub interactive_reply: bool,
    pub resume_session: bool,
    pub stop_signal: bool,
    pub structured_events: bool,
    /// The backend reports an **exact** cost figure (tokens + USD), taken directly.
    pub usage_exact: bool,
    /// The backend reports **exact token counts** but no USD, so the dollar value is
    /// **derived** from the operator-configurable rate table (ADR-0092 D2 / ADR-0052
    /// D2). The three usage flags mirror the spike's three usage shapes; at most one
    /// is set. The signal's own `fidelity` tag remains the load-bearing honesty
    /// mechanism — these flags are the coarse capability hint in the handshake.
    pub usage_derived: bool,
    /// The backend exposes neither exact USD nor exact tokens (e.g. premium-request
    /// counts only), so token/USD figures are **estimated** from proxies.
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
            usage_derived: false,
            usage_estimated: false,
        }
    }

    /// `codex.local` profile (ADR-0090 spike): message-level streaming, **resume-based**
    /// reply (the core uses the follow-up-run path, not same-process), stop + resume,
    /// structured events, and **exact tokens with a derived USD** (rate-table cost).
    pub fn codex_local() -> Self {
        Self {
            streaming_output: true,
            interactive_reply: false,
            resume_session: true,
            stop_signal: true,
            structured_events: true,
            usage_exact: false,
            usage_derived: true,
            usage_estimated: false,
        }
    }

    /// `copilot.local` profile (ADR-0090 spike): token-level streaming, resume-based
    /// reply, stop + resume, and **premium-requests + duration only** — so token/USD
    /// figures are estimated from proxies (the premium-request count is the real unit).
    pub fn copilot_local() -> Self {
        Self {
            streaming_output: true,
            interactive_reply: false,
            resume_session: true,
            stop_signal: true,
            structured_events: true,
            usage_exact: false,
            usage_derived: false,
            usage_estimated: true,
        }
    }

    pub fn one_shot() -> Self {
        Self {
            streaming_output: true,
            interactive_reply: false,
            resume_session: false,
            stop_signal: false,
            structured_events: false,
            usage_exact: false,
            usage_derived: false,
            usage_estimated: true,
        }
    }
}

/// A file the user attached to a chat turn (a document or a pasted/dropped image).
/// Carried inline (base64) over the wire; the runtime writes it to a per-run temp dir
/// and references the path in the task, so every adapter gets attachments uniformly via
/// path references — no per-CLI multimodal plumbing (HoneyHub attachments v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    /// The original file name. Sanitized to a safe basename before it is written.
    pub name: String,
    /// The MIME type when the client reported one (e.g. `image/png`); informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Base64-encoded file contents, with no `data:` URI prefix.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub session: DispatchSession,
    pub workspace_root: String,
    pub task: String,
    /// The model the user picked for this run (e.g. `opus`). When `None`, the
    /// adapter falls back to its configured/default model. Honored per-run so the
    /// run-screen model picker actually changes what launches (packet 09 §3c).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A named agent to run under (Claude `--agent <name>`). When `None`, the default
    /// session agent is used. Codex has no agent-invocation flag, so this is ignored by
    /// the Codex adapter (packet 09 §3d — agent launcher from chat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The reasoning effort the user picked (e.g. `high`). Maps to Codex's
    /// `-c model_reasoning_effort=<effort>`. Claude has no effort flag, so the Claude
    /// adapter ignores it (parity polish #9).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follow_up_to_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transcript: Vec<DispatchMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_command: Option<Vec<String>>,
    /// Files attached to this turn (documents, pasted/dropped images). The runtime
    /// materializes them to a temp dir and appends their paths to the task so the agent
    /// can read them. Empty = none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
    /// The run that dispatched this one, when it was started by an agent through the
    /// `dispatch_agent` capability (ADR-0098 C). `None` for every operator-started run.
    /// Additive on the wire (serde `default` + skip-if-none), so every existing frame
    /// stays byte-compatible — an operator run simply carries no parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    /// The session of the dispatching parent (ADR-0098 C). `None` for operator runs.
    /// Paired with `parent_run_id` so a child records who dispatched it and the Runs
    /// board can nest it under its parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHandle {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError>;
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
                process_id: Some(1234),
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
                run_id: "run-2".to_string(),
                process_id: None,
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
