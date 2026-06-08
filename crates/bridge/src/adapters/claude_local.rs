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

use crate::adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
use crate::adapters::child_run::{ChildRun, EventClock, RunSlot};
use crate::artifact::{ArtifactKind, DispatchArtifact};
use crate::session::{
    DispatchMessage, DispatchMessageRole, DispatchRunState, UsageConfidence, UsageFidelity,
    UsageSignal,
};
use crate::wire::{BridgeEvent, BridgeStatusEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

/// The `claude.local` backend adapter. Methods take `&self` (the trait contract),
/// so the live child processes live behind a `Mutex` for interior mutability.
pub struct ClaudeLocalAdapter {
    program: String,
    model: Option<String>,
    clock: EventClock,
    runs: Mutex<HashMap<String, RunSlot>>,
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
        }
    }

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, RunSlot>>, BridgeError> {
        self.runs
            .lock()
            .map_err(|_| BridgeError::new("lock_poisoned", "claude adapter lock was poisoned"))
    }

    fn base_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");
        if let Some(model) = &self.model {
            command.arg("--model").arg(model);
        }
        command
    }
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
        "issue_packet" => ArtifactKind::IssuePacket,
        "adr_draft" => ArtifactKind::AdrDraft,
        "pdr_draft" => ArtifactKind::PdrDraft,
        "log_bundle" => ArtifactKind::LogBundle,
        _ => ArtifactKind::Report,
    }
}

fn terminal_status(
    session_id: &str,
    run_id: &str,
    now: &str,
    state: DispatchRunState,
) -> BridgeEvent {
    BridgeEvent::status(
        Uuid::new_v4().to_string(),
        session_id,
        run_id,
        0,
        now.to_string(),
        BridgeStatusEvent {
            state,
            backend: AgentBackend::ClaudeLocal,
            repo_hint: None,
            link: None,
        },
    )
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
            let body = assistant_text(&value);
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
                    body,
                    created_at: now,
                    is_partial: Some(false),
                },
            )]
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

        let mut command = self.base_command();
        command.current_dir(&request.workspace_root);
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

        // Once the process has exited, emit a terminal status transition (exactly
        // once) so the run does not sit in `running`/`needs_input` forever after
        // the CLI finishes. A clean exit finalizes then completes; a non-zero exit
        // fails. Then retire the run so the child handle/threads/channel are freed
        // while the captured backend session id survives for a follow-up turn.
        let retired = if let Some(success) = run.poll_exit() {
            let now = (self.clock)();
            if success {
                events.push(terminal_status(
                    &session_id,
                    run_id,
                    &now,
                    DispatchRunState::Finalizing,
                ));
                events.push(terminal_status(
                    &session_id,
                    run_id,
                    &now,
                    DispatchRunState::Completed,
                ));
            } else {
                events.push(terminal_status(
                    &session_id,
                    run_id,
                    &now,
                    DispatchRunState::Failed,
                ));
            }
            slot.retire()
        } else {
            None
        };

        // Release the runs lock before dropping the retired child: `ChildRun::drop`
        // joins the stdout reader thread, which must not block other runs' access to
        // the lock.
        drop(guard);
        drop(retired);

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
        let mut command = self.base_command();
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

    #[test]
    fn failed_launch_reports_backend_unavailable() {
        let adapter = ClaudeLocalAdapter::new(
            "definitely-not-a-real-claude-binary-xyz",
            None,
            test_clock(),
        );
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
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
            requested_run_id: Some("run-1".to_string()),
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: None,
        };
        let error = adapter.start(request).expect_err("missing binary fails");
        assert_eq!(error.code, "backend_unavailable");
    }
}
