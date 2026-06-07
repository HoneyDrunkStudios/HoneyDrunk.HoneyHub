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
//! The crate stays clock-free (timestamps come from the caller everywhere else),
//! so the adapter takes an injected [`EventClock`] for stamping the events it
//! mints as the process streams. [`default_event_clock`] is a convenience for
//! production; tests inject a deterministic clock.

use crate::adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
use crate::artifact::{ArtifactKind, DispatchArtifact};
use crate::session::{
    DispatchMessage, DispatchMessageRole, DispatchRunState, UsageConfidence, UsageFidelity,
    UsageSignal,
};
use crate::wire::{BridgeEvent, BridgeStatusEvent};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use uuid::Uuid;

/// A timestamp source for events the adapter mints while streaming. Injected so
/// the bridge crate stays free of a wall-clock dependency and tests stay
/// deterministic.
pub type EventClock = Arc<dyn Fn() -> String + Send + Sync>;

/// A best-effort production clock: epoch milliseconds as a fixed-width string.
/// It sorts correctly for reconnect replay; a host that wants RFC3339 stamps can
/// inject its own clock instead.
pub fn default_event_clock() -> EventClock {
    Arc::new(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);
        format!("{millis:013}")
    })
}

struct RunProcess {
    session_id: String,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    /// The backend's own session id, captured from `system`/`result` events so a
    /// later `resume` can re-attach to the same Claude Code session.
    backend_session_id: Option<String>,
    /// Set once the process exit has been observed and its terminal status events
    /// emitted, so a later `stream` poll does not emit them again.
    finished: bool,
}

impl Drop for RunProcess {
    fn drop(&mut self) {
        // Closing stdin signals EOF; killing + reaping prevents a zombie, and the
        // reader thread ends once stdout closes.
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// The `claude.local` backend adapter. Methods take `&self` (the trait contract),
/// so the live child processes live behind a `Mutex` for interior mutability.
pub struct ClaudeLocalAdapter {
    program: String,
    model: Option<String>,
    clock: EventClock,
    runs: Mutex<HashMap<String, RunProcess>>,
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

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, RunProcess>>, BridgeError> {
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

    fn spawn(
        mut command: Command,
    ) -> Result<(Child, ChildStdin, Receiver<String>, JoinHandle<()>), BridgeError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "backend_unavailable",
                format!("failed to launch the claude CLI: {error}"),
            )
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            BridgeError::new("backend_unavailable", "claude CLI exposed no stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BridgeError::new("backend_unavailable", "claude CLI exposed no stdout")
        })?;

        // Drain stderr on its own thread so a chatty CLI cannot fill the stderr
        // pipe buffer and block the child while we are reading stdout.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut sink = std::io::sink();
                let _ = std::io::copy(&mut reader, &mut sink);
            });
        }

        let (sender, receiver) = channel();
        let reader = std::thread::spawn(move || {
            let buffered = BufReader::new(stdout);
            for line in buffered.lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok((child, stdin, receiver, reader))
    }
}

fn write_user_line(stdin: &mut ChildStdin, text: &str) -> Result<(), BridgeError> {
    let frame = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    let line = serde_json::to_string(&frame)
        .map_err(|error| BridgeError::new("encode_error", error.to_string()))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            BridgeError::new(
                "io_error",
                format!("failed to write to claude stdin: {error}"),
            )
        })
}

#[cfg(windows)]
fn kill_process_tree(child: &mut Child) {
    // `Child::kill` only kills the immediate process on Windows; `taskkill /T`
    // takes the whole tree the CLI may have spawned. Both are best-effort: an
    // already-exited process simply returns an error we ignore.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .output();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
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
        let (child, stdin, lines, reader) = Self::spawn(command)?;
        let process_id = child.id();

        let mut run = RunProcess {
            session_id: request.session.id.clone(),
            child,
            stdin: Some(stdin),
            lines,
            reader: Some(reader),
            backend_session_id: None,
            finished: false,
        };

        // Seed the first turn with the task, keeping stdin OPEN so later replies
        // are same-process live input rather than a resume. If the seed write
        // fails, dropping `run` here kills and reaps the child (no orphan).
        if let Some(stdin) = run.stdin.as_mut() {
            write_user_line(stdin, &request.task)?;
        }

        self.lock_runs()?.insert(run_id.clone(), run);

        Ok(RunHandle {
            run_id,
            process_id: Some(process_id),
        })
    }

    fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
        let mut guard = self.lock_runs()?;
        let run = guard
            .get_mut(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;

        let mut lines = Vec::new();
        loop {
            match run.lines.try_recv() {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => lines.push(line),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }

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
        // fails.
        if !run.finished {
            if let Ok(Some(status)) = run.child.try_wait() {
                run.finished = true;
                let now = (self.clock)();
                if status.success() {
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
            }
        }

        Ok(events)
    }

    fn reply(&self, run_id: &str, text: &str) -> Result<(), BridgeError> {
        let mut guard = self.lock_runs()?;
        let run = guard
            .get_mut(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        let stdin = run.stdin.as_mut().ok_or_else(|| {
            BridgeError::new("reply_unavailable", "claude stdin is closed for this run")
        })?;
        write_user_line(stdin, text)
    }

    fn stop(&self, run_id: &str) -> Result<(), BridgeError> {
        // Remove the run so its `Child`, reader thread, and channel are released
        // (no per-stopped-run leak). Killing the tree before drop covers the
        // Windows case where `Child::kill` alone would miss child processes; the
        // `RunProcess` drop then reaps and joins.
        let mut run = self
            .lock_runs()?
            .remove(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        run.stdin.take();
        kill_process_tree(&mut run.child);
        Ok(())
    }

    fn resume(&self, session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
        let run_id = Uuid::new_v4().to_string();
        let mut command = self.base_command();
        command.arg("-r").arg(session_id_or_transcript);
        let (child, stdin, lines, reader) = Self::spawn(command)?;
        let process_id = child.id();

        self.lock_runs()?.insert(
            run_id.clone(),
            RunProcess {
                session_id: session_id_or_transcript.to_string(),
                child,
                stdin: Some(stdin),
                lines,
                reader: Some(reader),
                backend_session_id: Some(session_id_or_transcript.to_string()),
                finished: false,
            },
        );

        Ok(RunHandle {
            run_id,
            process_id: Some(process_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
