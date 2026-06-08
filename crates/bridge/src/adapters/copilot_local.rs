//! `copilot.local` adapter — drives the official GitHub Copilot CLI under the
//! user's own local `gh` token (ADR-0090 D2/D10; ADR-0092 D2; packet 09 §3b).
//!
//! Copilot's spike profile:
//! - **Token-level streaming** via `assistant.message_delta` (like Claude, unlike
//!   Codex's message-level items): the adapter surfaces deltas as partial messages
//!   and a final assembled message on turn completion.
//! - **Resume-based reply** (like Codex): `interactive_reply` is `false`, so the
//!   core routes a reply through the follow-up-run path.
//! - **Premium-requests + duration only** for usage — no tokens, no USD. The
//!   premium-request count is the *real* billing unit; token/USD figures are
//!   **estimated** from a text-size proxy (ADR-0092 D2 / packet 09 §3b), tagged
//!   `estimated` with low confidence so the UI never renders them as exact.
//!   (Spike finding: Copilot's CLI runs a Claude model under the hood on a separate
//!   premium-request billing bucket, not a token bill.)
//!
//! Because the token estimate needs the accumulated assistant-text size, this
//! adapter composes the shared [`super::child_run`] driver inside a small per-run
//! state ([`CopilotRun`]) that also carries the running character counts — the
//! driver stays generic; the estimation is local to Copilot.
//!
//! NOTE (packet 09 §3b re-scope): the exact Copilot CLI invocation is the spike's
//! best-known shape and is isolated to [`CopilotLocalAdapter::exec_command`] for
//! live-CLI dogfood validation. The parsing, estimation, and follow-up wiring below
//! are independent of the precise flags and covered by the `fake_copilot` fixture.

use crate::adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
use crate::adapters::child_run::{ChildRun, EventClock};
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

/// Rough chars-per-token divisor for the estimated token proxy. Deliberately coarse
/// — the figure is tagged `estimated` / low-confidence and never drives a hard action.
const CHARS_PER_TOKEN: usize = 4;

/// Per-run state: the shared child driver plus the running character counts the
/// token estimate is built from.
struct CopilotRun {
    child: ChildRun,
    /// Characters of the prompt for this turn (input-token proxy).
    input_chars: usize,
    /// Characters of assistant output accumulated across deltas (output-token proxy).
    output_chars: usize,
    /// Whether the terminal usage signal has been emitted (premium-request counted).
    usage_emitted: bool,
}

/// The `copilot.local` backend adapter. Live runs live behind a `Mutex` for the
/// interior mutability the `&self` trait contract requires.
pub struct CopilotLocalAdapter {
    program: String,
    clock: EventClock,
    runs: Mutex<HashMap<String, CopilotRun>>,
}

impl CopilotLocalAdapter {
    /// Build an adapter that launches `program` (normally `"copilot"`; a fake binary
    /// path under test) with the given clock.
    pub fn new(program: impl Into<String>, clock: EventClock) -> Self {
        Self {
            program: program.into(),
            clock,
            runs: Mutex::new(HashMap::new()),
        }
    }

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, CopilotRun>>, BridgeError> {
        self.runs
            .lock()
            .map_err(|_| BridgeError::new("lock_poisoned", "copilot adapter lock was poisoned"))
    }

    /// Build the Copilot CLI command for one turn. A fresh turn passes the prompt; a
    /// resumed turn re-attaches the prior session. This is the single
    /// CLI-shape-dependent surface (packet 09 §3b re-scope point).
    fn exec_command(&self, task: &str, resume_session: Option<&str>) -> Command {
        let mut command = Command::new(&self.program);
        command.arg("--json");
        if let Some(session) = resume_session {
            command.arg("--resume").arg(session);
        }
        if !task.is_empty() {
            command.arg("--prompt").arg(task);
        }
        command
    }

    fn backend_session_of(&self, run_id: &str) -> Option<String> {
        self.lock_runs().ok().and_then(|guard| {
            guard
                .get(run_id)
                .and_then(|run| run.child.backend_session_id.clone())
        })
    }
}

fn session_id_from(value: &Value) -> Option<String> {
    ["session_id", "thread_id", "id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

fn estimated_tokens(chars: usize) -> u64 {
    (chars / CHARS_PER_TOKEN) as u64
}

fn agent_message(
    body: String,
    is_partial: bool,
    session_id: &str,
    run_id: &str,
    now: &str,
) -> BridgeEvent {
    BridgeEvent::message(
        Uuid::new_v4().to_string(),
        session_id,
        run_id,
        0,
        now.to_string(),
        DispatchMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            role: DispatchMessageRole::Agent,
            body,
            created_at: now.to_string(),
            is_partial: Some(is_partial),
        },
    )
}

/// The inputs to one Copilot usage estimate: the exact premium-request/duration
/// units the CLI reports, plus the character counts the token figures are estimated
/// from.
struct UsageEstimate<'a> {
    premium_requests: u64,
    duration_ms: Option<u64>,
    input_chars: usize,
    output_chars: usize,
    model: Option<&'a str>,
}

fn estimated_usage_signal(
    estimate: UsageEstimate<'_>,
    session_id: &str,
    run_id: &str,
    now: &str,
) -> UsageSignal {
    let input_tokens = estimated_tokens(estimate.input_chars);
    let output_tokens = estimated_tokens(estimate.output_chars);
    UsageSignal {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        backend: AgentBackend::CopilotLocal,
        // premium-requests + duration are exact, but the token/USD figures are
        // proxy estimates, so the signal's fidelity is `estimated` (ADR-0092 D2):
        // the UI must never render these as exact.
        fidelity: UsageFidelity::Estimated,
        model_label: estimate.model.map(str::to_string),
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        total_tokens: Some(input_tokens + output_tokens),
        // No USD: Copilot bills in premium requests, not a computable token cost.
        total_usd: None,
        premium_requests: Some(estimate.premium_requests),
        duration_ms: estimate.duration_ms,
        confidence: Some(UsageConfidence::Low),
        recorded_at: now.to_string(),
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
            backend: AgentBackend::CopilotLocal,
            repo_hint: None,
            link: None,
        },
    )
}

/// The outcome of parsing one Copilot JSONL line: events to emit plus the number of
/// assistant-output characters seen (folded into the run's running estimate).
struct ParseResult {
    events: Vec<BridgeEvent>,
    output_chars: usize,
}

/// Parse one JSONL line from the Copilot CLI. Token-level `assistant.message_delta`
/// becomes a partial message; a completion event becomes a final message plus the
/// estimated usage signal. Unknown/unparseable lines are ignored.
fn parse_line(
    clock: &EventClock,
    line: &str,
    run_id: &str,
    session_id: &str,
    input_chars: usize,
    output_chars_so_far: usize,
    backend_session_id: &mut Option<String>,
) -> ParseResult {
    let mut result = ParseResult {
        events: Vec::new(),
        output_chars: 0,
    };
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return result;
    };
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let now = (clock)();

    match kind {
        "session.created" | "session.configured" | "thread.started" => {
            if let Some(id) = session_id_from(&value) {
                *backend_session_id = Some(id);
            }
        }
        "assistant.message_delta" => {
            let delta = value
                .get("delta")
                .and_then(Value::as_str)
                .or_else(|| value.get("text").and_then(Value::as_str))
                .unwrap_or_default();
            if !delta.is_empty() {
                result.output_chars = delta.chars().count();
                result.events.push(agent_message(
                    delta.to_string(),
                    true,
                    session_id,
                    run_id,
                    &now,
                ));
            }
        }
        "assistant.message_completed" | "turn.completed" => {
            if let Some(id) = session_id_from(&value) {
                *backend_session_id = Some(id);
            }
            // A final assembled message, when the CLI provides the whole text.
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    result.events.push(agent_message(
                        text.to_string(),
                        false,
                        session_id,
                        run_id,
                        &now,
                    ));
                }
            }
            // One premium request per completed turn unless the CLI reports a count.
            let premium_requests = value
                .get("premium_requests")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            let duration_ms = value.get("duration_ms").and_then(Value::as_u64);
            let model = value.get("model").and_then(Value::as_str);
            result.events.push(BridgeEvent::usage(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.clone(),
                estimated_usage_signal(
                    UsageEstimate {
                        premium_requests,
                        duration_ms,
                        input_chars,
                        output_chars: output_chars_so_far,
                        model,
                    },
                    session_id,
                    run_id,
                    &now,
                ),
            ));
        }
        _ => {}
    }
    result
}

impl AgentBackendAdapter for CopilotLocalAdapter {
    fn backend(&self) -> AgentBackend {
        AgentBackend::CopilotLocal
    }

    fn capabilities(&self) -> CapabilityFlags {
        CapabilityFlags::copilot_local()
    }

    fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
        let run_id = request
            .requested_run_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let resume_session = request
            .follow_up_to_run_id
            .as_deref()
            .and_then(|prior| self.backend_session_of(prior));

        let mut command = self.exec_command(&request.task, resume_session.as_deref());
        command.current_dir(&request.workspace_root);
        let child = ChildRun::spawn(command, request.session.id.clone(), resume_session)?;
        let process_id = child.process_id();

        self.lock_runs()?.insert(
            run_id.clone(),
            CopilotRun {
                child,
                input_chars: request.task.chars().count(),
                output_chars: 0,
                usage_emitted: false,
            },
        );

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

        let lines = run.child.drain_lines();
        let session_id = run.child.session_id.clone();
        let input_chars = run.input_chars;
        let mut events = Vec::new();
        for line in lines {
            let parsed = parse_line(
                &self.clock,
                &line,
                run_id,
                &session_id,
                input_chars,
                run.output_chars,
                &mut run.child.backend_session_id,
            );
            run.output_chars += parsed.output_chars;
            if parsed
                .events
                .iter()
                .any(|event| matches!(event.payload, crate::wire::BridgeEventPayload::Usage { .. }))
            {
                run.usage_emitted = true;
            }
            events.extend(parsed.events);
        }

        // Terminal transition on process exit (exactly once). If the CLI exited
        // cleanly without a completion event carrying usage, synthesize the estimated
        // usage signal from what we accumulated so a turn always reports its premium
        // request (the real billing unit) — never silently dropping it.
        if let Some(success) = run.child.poll_exit() {
            let now = (self.clock)();
            if success {
                if !run.usage_emitted {
                    run.usage_emitted = true;
                    events.push(BridgeEvent::usage(
                        Uuid::new_v4().to_string(),
                        &session_id,
                        run_id,
                        0,
                        now.clone(),
                        estimated_usage_signal(
                            UsageEstimate {
                                premium_requests: 1,
                                duration_ms: None,
                                input_chars: run.input_chars,
                                output_chars: run.output_chars,
                                model: None,
                            },
                            &session_id,
                            run_id,
                            &now,
                        ),
                    ));
                }
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

        Ok(events)
    }

    fn reply(&self, _run_id: &str, _text: &str) -> Result<(), BridgeError> {
        // Resume-based: the core checks `interactive_reply` (false) and routes
        // replies through the follow-up-run path, so this is never reached in normal
        // flow. Fail honestly if a caller bypasses the capability gate.
        Err(BridgeError::new(
            "reply_unavailable",
            "copilot is resume-based; replies route through a follow-up run",
        ))
    }

    fn stop(&self, run_id: &str) -> Result<(), BridgeError> {
        let mut run = self
            .lock_runs()?
            .remove(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        run.child.close_and_kill();
        Ok(())
    }

    fn resume(&self, session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
        let run_id = Uuid::new_v4().to_string();
        let command = self.exec_command("", Some(session_id_or_transcript));
        let child = ChildRun::spawn(
            command,
            session_id_or_transcript.to_string(),
            Some(session_id_or_transcript.to_string()),
        )?;
        let process_id = child.process_id();

        self.lock_runs()?.insert(
            run_id.clone(),
            CopilotRun {
                child,
                input_chars: 0,
                output_chars: 0,
                usage_emitted: false,
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
    use std::sync::Arc;

    fn test_clock() -> EventClock {
        Arc::new(|| "2026-06-08T12:00:00Z".to_string())
    }

    #[test]
    fn declares_spike_observed_capabilities() {
        let adapter = CopilotLocalAdapter::new("copilot", test_clock());
        let capabilities = adapter.capabilities();

        assert!(capabilities.streaming_output);
        assert!(!capabilities.interactive_reply);
        assert!(capabilities.resume_session);
        assert!(capabilities.stop_signal);
        assert!(!capabilities.usage_exact);
        assert!(!capabilities.usage_derived);
        assert!(capabilities.usage_estimated);
        assert_eq!(adapter.backend(), AgentBackend::CopilotLocal);
    }

    #[test]
    fn message_delta_becomes_a_partial_message() {
        let mut backend_session = None;
        let parsed = parse_line(
            &test_clock(),
            r#"{"type":"assistant.message_delta","delta":"hello"}"#,
            "run-1",
            "session-1",
            0,
            0,
            &mut backend_session,
        );
        assert_eq!(parsed.output_chars, 5);
        match &parsed.events[0].payload {
            crate::wire::BridgeEventPayload::Message { message } => {
                assert_eq!(message.body, "hello");
                assert_eq!(message.is_partial, Some(true));
            }
            other => panic!("expected a partial message, got {other:?}"),
        }
    }

    #[test]
    fn turn_completed_emits_estimated_usage_with_premium_requests() {
        let mut backend_session = None;
        let parsed = parse_line(
            &test_clock(),
            r#"{"type":"turn.completed","model":"claude-sonnet-4.6","premium_requests":1,"duration_ms":2500}"#,
            "run-1",
            "session-1",
            40,  // input chars
            400, // output chars accumulated so far
            &mut backend_session,
        );
        let usage = parsed
            .events
            .iter()
            .find_map(|event| match &event.payload {
                crate::wire::BridgeEventPayload::Usage { signal } => Some(signal),
                _ => None,
            })
            .expect("a usage signal");
        assert_eq!(usage.fidelity, UsageFidelity::Estimated);
        assert_eq!(usage.premium_requests, Some(1));
        assert_eq!(usage.duration_ms, Some(2500));
        // Estimated tokens: 40/4 input, 400/4 output.
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(100));
        assert_eq!(usage.total_tokens, Some(110));
        // No USD: Copilot bills premium requests, not a computable token cost.
        assert_eq!(usage.total_usd, None);
        assert_eq!(usage.confidence, Some(UsageConfidence::Low));
        assert_eq!(usage.backend, AgentBackend::CopilotLocal);
    }

    #[test]
    fn captures_session_id_for_resume() {
        let mut backend_session = None;
        parse_line(
            &test_clock(),
            r#"{"type":"session.created","session_id":"copilot-sess-3"}"#,
            "run-1",
            "session-1",
            0,
            0,
            &mut backend_session,
        );
        assert_eq!(backend_session.as_deref(), Some("copilot-sess-3"));
    }

    #[test]
    fn ignores_unparseable_and_unknown_lines() {
        let mut backend_session = None;
        assert!(parse_line(
            &test_clock(),
            "not json",
            "r",
            "s",
            0,
            0,
            &mut backend_session
        )
        .events
        .is_empty());
        assert!(parse_line(
            &test_clock(),
            r#"{"type":"mystery"}"#,
            "r",
            "s",
            0,
            0,
            &mut backend_session
        )
        .events
        .is_empty());
    }

    #[test]
    fn reply_is_unavailable_resume_based() {
        let adapter = CopilotLocalAdapter::new("copilot", test_clock());
        let error = adapter
            .reply("run-1", "continue")
            .expect_err("copilot reply is resume-based");
        assert_eq!(error.code, "reply_unavailable");
    }

    #[test]
    fn failed_launch_reports_backend_unavailable() {
        let adapter =
            CopilotLocalAdapter::new("definitely-not-a-real-copilot-binary-xyz", test_clock());
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                id: "s1".to_string(),
                backend: AgentBackend::CopilotLocal,
                title: "t".to_string(),
                workspace_root: ".".to_string(),
                created_at: "2026-06-08T12:00:00Z".to_string(),
                updated_at: "2026-06-08T12:00:00Z".to_string(),
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
