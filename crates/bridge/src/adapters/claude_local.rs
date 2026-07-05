//! `claude.local` adapter — drives the official Claude Code CLI under the user's
//! own local session (ADR-0090 D2, D4, D10; ADR-0092 D2).
//!
//! The bridge **shells out** to the official `claude` CLI in streaming JSON mode
//! and never holds, stores, or proxies the subscription auth (`[Firm]` D10). The
//! CLI runs as a long-lived child process: user messages are written as
//! line-delimited JSON to its still-open stdin (which is what makes
//! `interactive_reply` a same-process live reply, not a resume), and structured
//! events are read from its stdout as JSONL and mapped to the core's
//! `BridgeEvent`s. `result` events carry the exact tokens + USD that become a
//! `fidelity: exact` `UsageSignal`, taken directly with no rate-table computation
//! (ADR-0092 D2).
//!
//! All the child-process mechanics (spawn, stderr drain, stdout reader thread,
//! process-tree kill, exit detection) live in the shared [`super::child_run`]
//! driver; this module is just the Claude-specific strategy: the command, the
//! capability flags, the `stream-json` line parsing, and the same-process reply
//! framing.

use crate::activity::{ActivityKind, DispatchActivity};
use crate::adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
use crate::adapters::child_run::{ChildRun, EventClock, RunSlot};
use crate::artifact::{ArtifactKind, DispatchArtifact};
use crate::dispatch::{DispatchCaller, DispatchGovernor, DISPATCH_SERVER_NAME};
use crate::session::{
    DispatchMessage, DispatchMessageRole, DispatchRunState, UsageConfidence, UsageFidelity,
    UsageSignal,
};
use crate::wire::{BridgeEvent, BridgeStatusEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

/// The `claude.local` backend adapter. Methods take `&self` (the trait contract),
/// so the live child processes live behind a `Mutex` for interior mutability.
pub struct ClaudeLocalAdapter {
    program: String,
    model: Option<String>,
    clock: EventClock,
    runs: Mutex<HashMap<String, RunSlot>>,
    /// The cross-backend dispatch governor (ADR-0098), when the host wired it. When
    /// present **and enabled**, each launch injects the bridge `dispatch_agent` MCP
    /// endpoint (`--mcp-config`) with a per-run capability token, so the Claude
    /// session can spawn parented subagents. `None`/disabled = no injection, and the
    /// run launches normally without the tool (graceful degradation).
    dispatch: Option<Arc<DispatchGovernor>>,
}

impl ClaudeLocalAdapter {
    /// Build an adapter that launches `program` (normally `"claude"`; a fake
    /// binary path under test) with an optional `--model` and the given clock.
    pub fn new(program: impl Into<String>, model: Option<String>, clock: EventClock) -> Self {
        Self {
            program: program.into(),
            model,
            clock,
            runs: Mutex::new(HashMap::new()),
            dispatch: None,
        }
    }

    /// Wire the cross-backend dispatch governor (ADR-0098) so each launched Claude
    /// session receives the `dispatch_agent` tool via an injected MCP endpoint.
    /// Chainable; `None` (the default) leaves dispatch off. The token minted per run
    /// is what makes a `dispatch_agent` call attributable to the parent run.
    pub fn with_dispatch(mut self, dispatch: Option<Arc<DispatchGovernor>>) -> Self {
        self.dispatch = dispatch;
        self
    }

    /// The extra CLI args that inject the bridge dispatch MCP endpoint into a launch,
    /// or `None` when dispatch is unwired or disabled (graceful degradation: the run
    /// launches with no `dispatch_agent` tool). Minting the capability token here
    /// binds it to **this** run, so a `dispatch_agent` call the session makes is
    /// attributable back to it (ADR-0098 B). Kept as a pure arg-builder so the
    /// injection decision is unit-testable without spawning a CLI.
    fn dispatch_mcp_args(&self, run_id: &str, request: &StartRunRequest) -> Option<Vec<String>> {
        let governor = self.dispatch.as_ref()?;
        if !governor.is_enabled() {
            return None;
        }
        let token = governor.issue_token(DispatchCaller {
            session_id: request.session.id.clone(),
            run_id: run_id.to_string(),
            backend: AgentBackend::ClaudeLocal,
            workspace_root: request.workspace_root.clone(),
        });
        Some(vec![
            "--mcp-config".to_string(),
            build_mcp_config_json(governor.endpoint(), &token),
        ])
    }

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, RunSlot>>, BridgeError> {
        self.runs
            .lock()
            .map_err(|_| BridgeError::new("lock_poisoned", "claude adapter lock was poisoned"))
    }

    /// Off-lock finalization for an exited run: drain the child's final lines (the
    /// closing `result` line carries exact tokens + USD), carry any tail-discovered
    /// vendor session id back to the retired slot, then push the terminal transition.
    fn finalize_exited_run(
        &self,
        success: bool,
        run_id: &str,
        session_id: &str,
        retired: Option<Box<ChildRun>>,
        events: &mut Vec<BridgeEvent>,
    ) {
        let mut tail_session_id = None;
        if let Some(mut child) = retired {
            for line in child.drain_remaining(std::time::Duration::from_secs(2)) {
                events.extend(parse_line(
                    &self.clock,
                    &line,
                    run_id,
                    session_id,
                    &mut child.backend_session_id,
                ));
            }
            tail_session_id = child.backend_session_id.clone();
            // `child` drops here, off-lock: reader-thread join (and the one-time tree
            // kill that forces stdout EOF) happen without the lock held.
        }

        // Sync any tail-discovered vendor session id into the retired `Done` slot.
        if tail_session_id.is_some() {
            if let Ok(mut guard) = self.lock_runs() {
                if let Some(slot) = guard.get_mut(run_id) {
                    slot.set_done_backend_session_id(tail_session_id);
                }
            }
        }

        let now = (self.clock)();
        super::common::push_terminal_status(
            events,
            AgentBackend::ClaudeLocal,
            success,
            session_id,
            run_id,
            &now,
        );
    }

    /// Build the base CLI command. `model_override` (the user's per-run pick) takes
    /// precedence over the adapter's configured default; when neither is set the CLI
    /// uses its own default model. `agent_override` (the chat agent picker) maps to
    /// Claude's `--agent <name>`, overriding the session's default agent.
    fn base_command(&self, model_override: Option<&str>, agent_override: Option<&str>) -> Command {
        let mut command = Command::new(&self.program);
        command
            .arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");
        let model = model_override.or(self.model.as_deref());
        if let Some(model) = model {
            command.arg("--model").arg(model);
        }
        if let Some(agent) = agent_override {
            let agent = agent.trim();
            if !agent.is_empty() {
                command.arg("--agent").arg(agent);
            }
        }
        command
    }
}

/// Build the Claude Code `--mcp-config` JSON that points a launched session at the
/// bridge's dispatch MCP endpoint, authenticated with the per-run capability token.
/// Claude Code accepts an inline JSON string for `--mcp-config`; the entry is an
/// HTTP MCP server carrying an `Authorization: Bearer` header (ADR-0098 B). Built
/// with serde so the URL and token are always correctly escaped, and additive to
/// the existing arg-builder so nothing else about the launch changes.
fn build_mcp_config_json(endpoint: &str, token: &str) -> String {
    let mut servers = serde_json::Map::new();
    servers.insert(
        DISPATCH_SERVER_NAME.to_string(),
        serde_json::json!({
            "type": "http",
            "url": endpoint,
            "headers": { "Authorization": format!("Bearer {token}") },
        }),
    );
    serde_json::json!({ "mcpServers": Value::Object(servers) }).to_string()
}

/// Write a Claude `user` turn frame to the run's stdin, keeping the same process
/// alive (the live-reply mechanism that distinguishes Claude from the resume-based
/// backends).
fn write_user_line(run: &mut ChildRun, text: &str) -> Result<(), BridgeError> {
    let frame = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    let line = serde_json::to_string(&frame)
        .map_err(|error| BridgeError::new("encode_error", error.to_string()))?;
    run.write_stdin_line(&line)
}

fn assistant_text(value: &Value) -> String {
    let content = value
        .get("message")
        .and_then(|message| message.get("content"));
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Map a Claude tool name to an activity kind. Names follow Claude Code's tool set.
fn classify_tool(name: &str) -> ActivityKind {
    match name {
        "Read" | "Glob" | "LS" | "NotebookRead" => ActivityKind::Read,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ActivityKind::Edit,
        "Bash" | "BashOutput" | "KillBash" => ActivityKind::Command,
        "Grep" => ActivityKind::Search,
        "WebFetch" | "WebSearch" => ActivityKind::Fetch,
        _ => ActivityKind::Tool,
    }
}

/// A short, non-sensitive detail for a tool call: a path, command, pattern, or url, trimmed
/// to a reasonable length. Returns `None` when nothing concise is available.
fn tool_detail(name: &str, input: &Value) -> Option<String> {
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input.get(*key).and_then(Value::as_str))
            .map(str::to_string)
    };
    let raw = match name {
        "Bash" => pick(&["command", "description"]),
        "Grep" => pick(&["pattern"]),
        "WebFetch" | "WebSearch" => pick(&["url", "query"]),
        _ => pick(&["file_path", "path", "notebook_path", "pattern"]),
    };
    raw.map(|detail| {
        let trimmed = detail.trim();
        if trimmed.chars().count() > 120 {
            format!("{}…", trimmed.chars().take(120).collect::<String>())
        } else {
            trimmed.to_string()
        }
    })
    .filter(|detail| !detail.is_empty())
}

/// Extract activity events from an assistant message's `tool_use` content blocks, so the UI
/// can show what the agent is doing (metadata only — never the tool's full input/output).
fn tool_activities(value: &Value, session_id: &str, run_id: &str, now: &str) -> Vec<BridgeEvent> {
    let Some(blocks) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|block| {
            let name = block.get("name").and_then(Value::as_str)?;
            let empty = Value::Object(serde_json::Map::new());
            let input = block.get("input").unwrap_or(&empty);
            Some(BridgeEvent::activity(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.to_string(),
                DispatchActivity {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    kind: classify_tool(name),
                    label: name.to_string(),
                    detail: tool_detail(name, input),
                    created_at: now.to_string(),
                },
            ))
        })
        .collect()
}

fn usage_signal(value: &Value, session_id: &str, run_id: &str, now: &str) -> UsageSignal {
    let usage = value.get("usage");
    let token_field = |name: &str| {
        usage
            .and_then(|usage| usage.get(name))
            .and_then(Value::as_u64)
    };
    let input_tokens = token_field("input_tokens");
    let output_tokens = token_field("output_tokens");
    // Claude usage also reports cache-read / cache-creation input tokens; fold them
    // into the total so an `exact` signal does not under-report (ADR-0092 D2).
    let cache_read = token_field("cache_read_input_tokens");
    let cache_creation = token_field("cache_creation_input_tokens");
    let total_tokens = if input_tokens.is_some() || output_tokens.is_some() {
        Some(
            input_tokens.unwrap_or(0)
                + output_tokens.unwrap_or(0)
                + cache_read.unwrap_or(0)
                + cache_creation.unwrap_or(0),
        )
    } else {
        None
    };
    UsageSignal {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        backend: AgentBackend::ClaudeLocal,
        // Claude Code reports exact tokens + USD; taken directly, no computation
        // (ADR-0092 D2). USD is never derived from a rate table for this backend.
        fidelity: UsageFidelity::Exact,
        model_label: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        input_tokens,
        output_tokens,
        total_tokens,
        total_usd: value.get("total_cost_usd").and_then(Value::as_f64),
        premium_requests: None,
        duration_ms: value.get("duration_ms").and_then(Value::as_u64),
        confidence: Some(UsageConfidence::High),
        recorded_at: now.to_string(),
    }
}

fn artifact_kind(label: &str) -> ArtifactKind {
    match label {
        "branch" => ArtifactKind::Branch,
        "commit" => ArtifactKind::Commit,
        "pull_request" => ArtifactKind::PullRequest,
        "work_item" => ArtifactKind::WorkItem,
        "adr_draft" => ArtifactKind::AdrDraft,
        "pdr_draft" => ArtifactKind::PdrDraft,
        "log_bundle" => ArtifactKind::LogBundle,
        _ => ArtifactKind::Report,
    }
}

/// Parse one JSONL line from the CLI into zero or more `BridgeEvent`s. Unknown or
/// unparseable lines are ignored (never fabricated into a stream). The adapter
/// sets `sequence: 0`; the core re-stamps it on ingest.
fn parse_line(
    clock: &EventClock,
    line: &str,
    run_id: &str,
    session_id: &str,
    backend_session_id: &mut Option<String>,
) -> Vec<BridgeEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let now = (clock)();

    match kind {
        "system" => {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                *backend_session_id = Some(id.to_string());
            }
            Vec::new()
        }
        "assistant" => {
            // Surface tool calls as activity events; emit the prose message only when the
            // turn carries text (a tool-only turn has an empty body).
            let mut events = tool_activities(&value, session_id, run_id, &now);
            let body = assistant_text(&value);
            if !body.is_empty() {
                events.push(BridgeEvent::message(
                    Uuid::new_v4().to_string(),
                    session_id,
                    run_id,
                    0,
                    now.clone(),
                    DispatchMessage {
                        id: Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        role: DispatchMessageRole::Agent,
                        body,
                        created_at: now,
                        is_partial: Some(false),
                    },
                ));
            }
            events
        }
        "stream_event" => {
            let delta = value
                .get("event")
                .and_then(|event| event.get("delta"))
                .and_then(|delta| delta.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                return Vec::new();
            }
            vec![BridgeEvent::message(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.clone(),
                DispatchMessage {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    role: DispatchMessageRole::Agent,
                    body: delta.to_string(),
                    created_at: now,
                    is_partial: Some(true),
                },
            )]
        }
        "needs_input" => vec![BridgeEvent::status(
            Uuid::new_v4().to_string(),
            session_id,
            run_id,
            0,
            now,
            BridgeStatusEvent {
                state: DispatchRunState::NeedsInput,
                backend: AgentBackend::ClaudeLocal,
                repo_hint: None,
                link: None,
            },
        )],
        "result" => {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                *backend_session_id = Some(id.to_string());
            }
            vec![BridgeEvent::usage(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.clone(),
                usage_signal(&value, session_id, run_id, &now),
            )]
        }
        "artifact" => {
            let kind = value
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let label = value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(kind)
                .to_string();
            vec![BridgeEvent::artifact(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.clone(),
                DispatchArtifact {
                    id: Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    kind: artifact_kind(kind),
                    label,
                    href: value
                        .get("href")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    repo_relative_path: value
                        .get("repo_relative_path")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    created_at: now,
                },
            )]
        }
        _ => Vec::new(),
    }
}

impl AgentBackendAdapter for ClaudeLocalAdapter {
    fn backend(&self) -> AgentBackend {
        AgentBackend::ClaudeLocal
    }

    fn capabilities(&self) -> CapabilityFlags {
        // Observed in the ADR-0090 feasibility spike (Appendix): token-level
        // streaming, same-process live reply, resume + memory, stop, structured
        // events, and exact tokens + USD. Declared honestly (`[Firm]` D4).
        CapabilityFlags::claude_local()
    }

    fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
        let run_id = request
            .requested_run_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut command = self.base_command(request.model.as_deref(), request.agent.as_deref());
        command.current_dir(&request.workspace_root);
        // Additively inject the dispatch MCP endpoint (ADR-0098) so this session gets
        // the `dispatch_agent` tool. Absent/disabled dispatch injects nothing, so the
        // run launches exactly as before (graceful degradation).
        if let Some(args) = self.dispatch_mcp_args(&run_id, &request) {
            command.args(args);
        }
        let mut run = ChildRun::spawn(command, request.session.id.clone(), None)?;
        let process_id = run.process_id();

        // Seed the first turn with the task, keeping stdin OPEN so later replies
        // are same-process live input rather than a resume. If the seed write
        // fails, dropping `run` here kills and reaps the child (no orphan).
        write_user_line(&mut run, &request.task)?;

        self.lock_runs()?.insert(run_id.clone(), RunSlot::live(run));

        Ok(RunHandle {
            run_id,
            process_id: Some(process_id),
        })
    }

    fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
        let mut guard = self.lock_runs()?;
        let slot = guard
            .get_mut(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        // A retired (completed) run has nothing left to stream.
        let Some(run) = slot.as_live_mut() else {
            return Ok(Vec::new());
        };

        let lines = run.drain_lines();
        let session_id = run.session_id.clone();
        let mut events = Vec::new();
        for line in lines {
            events.extend(parse_line(
                &self.clock,
                &line,
                run_id,
                &session_id,
                &mut run.backend_session_id,
            ));
        }

        // If the process has exited, retire the run (capturing the vendor session id,
        // which was set early from the `system`/`result` events) and take ownership of
        // the child. The remaining work — the bounded final-line drain and the child
        // drop, which joins the stdout reader thread — then happens **off** the runs
        // lock, so it never blocks another run's `stream`/`reply`/`stop`.
        let exit = run.poll_exit();
        let retired = if exit.is_some() { slot.retire() } else { None };
        drop(guard);

        if let Some(success) = exit {
            self.finalize_exited_run(success, run_id, &session_id, retired, &mut events);
        }

        Ok(events)
    }

    fn reply(&self, run_id: &str, text: &str) -> Result<(), BridgeError> {
        let mut guard = self.lock_runs()?;
        let slot = guard
            .get_mut(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        let run = slot.as_live_mut().ok_or_else(|| {
            BridgeError::new("reply_unavailable", format!("run {run_id} has completed"))
        })?;
        write_user_line(run, text)
    }

    fn stop(&self, run_id: &str) -> Result<(), BridgeError> {
        // Remove the run so its child, reader thread, and channel are released (no
        // per-stopped-run leak). Killing the tree (idempotently) covers the Windows
        // case where `Child::kill` alone would miss child processes; the `ChildRun`
        // drop then joins the reader. A retired run has no live child to kill.
        let mut slot = self
            .lock_runs()?
            .remove(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        if let Some(run) = slot.as_live_mut() {
            run.close_and_kill();
        }
        Ok(())
    }

    fn resume(&self, session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
        let run_id = Uuid::new_v4().to_string();
        let mut command = self.base_command(None, None);
        command.arg("-r").arg(session_id_or_transcript);
        let run = ChildRun::spawn(
            command,
            session_id_or_transcript.to_string(),
            Some(session_id_or_transcript.to_string()),
        )?;
        let process_id = run.process_id();

        self.lock_runs()?.insert(run_id.clone(), RunSlot::live(run));

        Ok(RunHandle {
            run_id,
            process_id: Some(process_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_clock() -> EventClock {
        Arc::new(|| "2026-06-07T12:00:00Z".to_string())
    }

    #[test]
    fn declares_spike_observed_capabilities() {
        let adapter = ClaudeLocalAdapter::new("claude", None, test_clock());
        let capabilities = adapter.capabilities();

        assert!(capabilities.streaming_output);
        assert!(capabilities.interactive_reply);
        assert!(capabilities.resume_session);
        assert!(capabilities.stop_signal);
        assert!(capabilities.structured_events);
        assert!(capabilities.usage_exact);
        assert!(!capabilities.usage_estimated);
        assert_eq!(adapter.backend(), AgentBackend::ClaudeLocal);
    }

    #[test]
    fn parses_result_into_exact_usage_signal() {
        let mut backend_session = None;
        let line = r#"{"type":"result","subtype":"success","session_id":"sess-9","num_turns":2,"duration_ms":1500,"total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":40}}"#;
        let events = parse_line(
            &test_clock(),
            line,
            "run-1",
            "session-1",
            &mut backend_session,
        );

        assert_eq!(events.len(), 1);
        assert_eq!(backend_session.as_deref(), Some("sess-9"));
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.fidelity, UsageFidelity::Exact);
                assert_eq!(signal.input_tokens, Some(100));
                assert_eq!(signal.output_tokens, Some(40));
                assert_eq!(signal.total_tokens, Some(140));
                assert_eq!(signal.total_usd, Some(0.0123));
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
    }

    #[test]
    fn usage_total_includes_cache_tokens() {
        let mut backend_session = None;
        let line = r#"{"type":"result","session_id":"s","total_cost_usd":0.5,"usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}"#;
        let events = parse_line(
            &test_clock(),
            line,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.input_tokens, Some(100));
                assert_eq!(signal.output_tokens, Some(40));
                // 100 + 40 + 10 + 5
                assert_eq!(signal.total_tokens, Some(155));
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
    }

    #[test]
    fn parses_assistant_text_and_artifacts_and_needs_input() {
        let mut backend_session = None;
        let assistant = parse_line(
            &test_clock(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert!(matches!(
            assistant[0].payload,
            crate::wire::BridgeEventPayload::Message { .. }
        ));

        let needs_input = parse_line(
            &test_clock(),
            r#"{"type":"needs_input"}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert!(matches!(
            &needs_input[0].payload,
            crate::wire::BridgeEventPayload::Status { status }
                if status.state == DispatchRunState::NeedsInput
        ));

        let artifact = parse_line(
            &test_clock(),
            r#"{"type":"artifact","kind":"pull_request","label":"Open PR","href":"https://example.test/pr/1"}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &artifact[0].payload {
            crate::wire::BridgeEventPayload::Artifact { artifact } => {
                assert_eq!(artifact.kind, ArtifactKind::PullRequest);
                assert_eq!(artifact.href.as_deref(), Some("https://example.test/pr/1"));
            }
            other => panic!("expected an artifact payload, got {other:?}"),
        }
    }

    #[test]
    fn parses_tool_use_blocks_into_activity_events() {
        let mut backend_session = None;
        // A turn with a tool call AND prose: one activity + one message.
        let events = parse_line(
            &test_clock(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                {"type":"tool_use","name":"Edit","input":{"file_path":"src/app.rs"}},
                {"type":"text","text":"editing now"}
            ]}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Activity { activity } => {
                assert_eq!(activity.kind, ActivityKind::Edit);
                assert_eq!(activity.label, "Edit");
                assert_eq!(activity.detail.as_deref(), Some("src/app.rs"));
            }
            other => panic!("expected an activity payload, got {other:?}"),
        }
        assert!(matches!(
            events[1].payload,
            crate::wire::BridgeEventPayload::Message { .. }
        ));

        // A tool-only turn (no text) yields only the activity, no empty message.
        let tool_only = parse_line(
            &test_clock(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                {"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}
            ]}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert_eq!(tool_only.len(), 1);
        match &tool_only[0].payload {
            crate::wire::BridgeEventPayload::Activity { activity } => {
                assert_eq!(activity.kind, ActivityKind::Command);
                assert_eq!(activity.detail.as_deref(), Some("cargo test"));
            }
            other => panic!("expected an activity payload, got {other:?}"),
        }
    }

    #[test]
    fn ignores_unparseable_and_unknown_lines() {
        let mut backend_session = None;
        assert!(parse_line(&test_clock(), "not json", "r", "s", &mut backend_session).is_empty());
        assert!(parse_line(
            &test_clock(),
            r#"{"type":"mystery"}"#,
            "r",
            "s",
            &mut backend_session
        )
        .is_empty());
    }

    fn status_states(events: &[BridgeEvent]) -> Vec<DispatchRunState> {
        events
            .iter()
            .filter_map(|event| match &event.payload {
                crate::wire::BridgeEventPayload::Status { status } => Some(status.state.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn finalize_clean_exit_without_drain_pushes_finalizing_then_completed() {
        // `retired: None` covers the no-drain path (no live child needed) plus the
        // shared terminal push for a clean exit.
        let adapter = ClaudeLocalAdapter::new("claude", None, test_clock());
        let mut events = Vec::new();
        adapter.finalize_exited_run(true, "run-1", "session-1", None, &mut events);
        assert_eq!(
            status_states(&events),
            vec![DispatchRunState::Finalizing, DispatchRunState::Completed]
        );
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Status { status } => {
                assert_eq!(status.backend, AgentBackend::ClaudeLocal);
            }
            other => panic!("expected a status payload, got {other:?}"),
        }
    }

    #[test]
    fn finalize_failed_exit_without_drain_pushes_failed_only() {
        let adapter = ClaudeLocalAdapter::new("claude", None, test_clock());
        let mut events = Vec::new();
        adapter.finalize_exited_run(false, "run-1", "session-1", None, &mut events);
        assert_eq!(status_states(&events), vec![DispatchRunState::Failed]);
    }

    #[test]
    fn failed_launch_reports_backend_unavailable() {
        let adapter = ClaudeLocalAdapter::new(
            "definitely-not-a-real-claude-binary-xyz",
            None,
            test_clock(),
        );
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                pinned: false,
                id: "s1".to_string(),
                backend: AgentBackend::ClaudeLocal,
                title: "t".to_string(),
                workspace_root: ".".to_string(),
                created_at: "2026-06-07T12:00:00Z".to_string(),
                updated_at: "2026-06-07T12:00:00Z".to_string(),
                current_run_id: None,
            },
            workspace_root: ".".to_string(),
            task: "do it".to_string(),
            model: None,
            agent: None,
            effort: None,
            requested_run_id: Some("run-1".to_string()),
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: None,
            attachments: Vec::new(),
            parent_run_id: None,
            parent_session_id: None,
        };
        let error = adapter.start(request).expect_err("missing binary fails");
        assert_eq!(error.code, "backend_unavailable");
    }

    fn dispatch_request() -> StartRunRequest {
        StartRunRequest {
            session: crate::session::DispatchSession {
                pinned: false,
                id: "parent-session".to_string(),
                backend: AgentBackend::ClaudeLocal,
                title: "t".to_string(),
                workspace_root: "/work".to_string(),
                created_at: "2026-07-05T12:00:00Z".to_string(),
                updated_at: "2026-07-05T12:00:00Z".to_string(),
                current_run_id: None,
            },
            workspace_root: "/work".to_string(),
            task: "plan the thing".to_string(),
            model: None,
            agent: None,
            effort: None,
            requested_run_id: Some("parent-run".to_string()),
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: None,
            attachments: Vec::new(),
            parent_run_id: None,
            parent_session_id: None,
        }
    }

    #[test]
    fn injects_mcp_config_only_when_dispatch_enabled() {
        let request = dispatch_request();

        // No governor wired -> no injection (graceful: the run launches tool-less).
        let bare = ClaudeLocalAdapter::new("claude", None, test_clock());
        assert!(bare.dispatch_mcp_args("parent-run", &request).is_none());

        // A disabled governor (no allowed backends) also injects nothing.
        let off =
            ClaudeLocalAdapter::new("claude", None, test_clock()).with_dispatch(Some(Arc::new(
                DispatchGovernor::new("http://127.0.0.1:8765/mcp", vec![], 4),
            )));
        assert!(off.dispatch_mcp_args("parent-run", &request).is_none());

        // An enabled governor injects `--mcp-config` with the endpoint and a token
        // that resolves back to THIS parent run (attribution, ADR-0098 B).
        let governor = Arc::new(DispatchGovernor::new(
            "http://127.0.0.1:8765/mcp",
            vec![AgentBackend::CodexLocal],
            4,
        ));
        let adapter = ClaudeLocalAdapter::new("claude", None, test_clock())
            .with_dispatch(Some(governor.clone()));
        let args = adapter
            .dispatch_mcp_args("parent-run", &request)
            .expect("enabled dispatch injects args");
        assert_eq!(args[0], "--mcp-config");

        let config: Value = serde_json::from_str(&args[1]).expect("mcp config is valid json");
        let server = &config["mcpServers"][DISPATCH_SERVER_NAME];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "http://127.0.0.1:8765/mcp");
        let auth = server["headers"]["Authorization"]
            .as_str()
            .expect("authorization header present");
        let token = auth
            .strip_prefix("Bearer ")
            .expect("authorization is a bearer token");
        let caller = governor.resolve(token).expect("the minted token resolves");
        assert_eq!(caller.run_id, "parent-run");
        assert_eq!(caller.session_id, "parent-session");
        assert_eq!(caller.backend, AgentBackend::ClaudeLocal);
        assert_eq!(caller.workspace_root, "/work");
    }
}
