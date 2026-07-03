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
use crate::wire::BridgeEvent;
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

/// A run's slot: the live `CopilotRun`, or a retired record keeping only the captured
/// vendor session id. Mirrors [`super::child_run::RunSlot`] for the composed copilot
/// run type (which carries extra estimate state the shared `ChildRun`-only slot cannot
/// hold). Retiring a finished run frees the child handle, reader thread, and channel in
/// a long-lived host while still letting a follow-up turn resume the session.
enum CopilotSlot {
    // Boxed so the large live variant does not inflate every map entry.
    Live(Box<CopilotRun>),
    Done { backend_session_id: Option<String> },
}

impl CopilotSlot {
    fn live(run: CopilotRun) -> Self {
        CopilotSlot::Live(Box::new(run))
    }

    fn backend_session_id(&self) -> Option<&str> {
        match self {
            CopilotSlot::Live(run) => run.child.backend_session_id.as_deref(),
            CopilotSlot::Done { backend_session_id } => backend_session_id.as_deref(),
        }
    }

    fn as_live_mut(&mut self) -> Option<&mut CopilotRun> {
        match self {
            CopilotSlot::Live(run) => Some(run),
            CopilotSlot::Done { .. } => None,
        }
    }

    /// Retire to a `Done` record, returning the displaced run so the caller can drop
    /// it (which joins the stdout reader thread) *after* releasing the runs lock —
    /// see [`super::child_run::RunSlot::retire`]. Returns `None` if already retired.
    #[must_use = "drop the returned CopilotRun after releasing the runs lock"]
    fn retire(&mut self) -> Option<Box<CopilotRun>> {
        match self {
            CopilotSlot::Live(run) => {
                let backend_session_id = run.child.backend_session_id.clone();
                match std::mem::replace(self, CopilotSlot::Done { backend_session_id }) {
                    CopilotSlot::Live(run) => Some(run),
                    CopilotSlot::Done { .. } => None,
                }
            }
            CopilotSlot::Done { .. } => None,
        }
    }

    /// Record a vendor session id discovered after retirement (parsed off-lock from a
    /// drained tail line) so a later follow-up resume sees it. Only updates a retired
    /// slot, never clobbering a known id with `None`.
    fn set_done_backend_session_id(&mut self, id: Option<String>) {
        if let (CopilotSlot::Done { backend_session_id }, Some(id)) = (&mut *self, id) {
            *backend_session_id = Some(id);
        }
    }
}

/// The `copilot.local` backend adapter. Live runs live behind a `Mutex` for the
/// interior mutability the `&self` trait contract requires.
pub struct CopilotLocalAdapter {
    program: String,
    clock: EventClock,
    runs: Mutex<HashMap<String, CopilotSlot>>,
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

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, CopilotSlot>>, BridgeError> {
        self.runs
            .lock()
            .map_err(|_| BridgeError::new("lock_poisoned", "copilot adapter lock was poisoned"))
    }

    /// Build the Copilot CLI command for one turn. A fresh turn passes the prompt; a
    /// resumed turn re-attaches the prior session. This is the single
    /// CLI-shape-dependent surface (packet 09 §3b re-scope point).
    ///
    /// The prompt is passed via argv (`--prompt <task>`). For v1 — a local-first,
    /// single-user cockpit driving the user's own CLI with the user's own prompts on
    /// their own machine — argv exposure to co-resident process inspection is an
    /// accepted low-risk tradeoff. Migrating prompt delivery to stdin (as
    /// `claude.local` does) once the live CLI's stdin path is confirmed is tracked in
    /// HoneyHub#29.
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
                .and_then(|slot| slot.backend_session_id().map(str::to_string))
        })
    }

    /// Parse one drained line through the per-turn estimate accounting and fold the
    /// result into `run` (running output chars + the once-per-turn usage flag),
    /// extending `events` with anything emitted.
    fn account_line(
        &self,
        run: &mut CopilotRun,
        run_id: &str,
        session_id: &str,
        line: &str,
        events: &mut Vec<BridgeEvent>,
    ) {
        let parsed = parse_line(
            &self.clock,
            line,
            run_id,
            session_id,
            RunEstimate {
                input_chars: run.input_chars,
                output_chars_so_far: run.output_chars,
                usage_already_emitted: run.usage_emitted,
            },
            &mut run.child.backend_session_id,
        );
        run.output_chars += parsed.output_chars;
        if contains_usage(&parsed.events) {
            run.usage_emitted = true;
        }
        events.extend(parsed.events);
    }

    /// Off-lock finalization for an exited turn: drain the child's final lines through
    /// the same accounting, carry any tail-discovered vendor session id back to the
    /// retired slot, synthesize a usage signal if the turn ended without one (so a turn
    /// always reports its premium request), then push the terminal transition.
    fn finalize_exited_run(
        &self,
        success: bool,
        run_id: &str,
        session_id: &str,
        mut run: Box<CopilotRun>,
        events: &mut Vec<BridgeEvent>,
    ) {
        for line in run.child.drain_remaining(std::time::Duration::from_secs(2)) {
            self.account_line(&mut run, run_id, session_id, &line, events);
        }

        // Carry a vendor session id discovered only in the drained tail back to the
        // retired slot so a later follow-up resume still sees it.
        let tail_session_id = run.child.backend_session_id.clone();
        if tail_session_id.is_some() {
            if let Ok(mut guard) = self.lock_runs() {
                if let Some(slot) = guard.get_mut(run_id) {
                    slot.set_done_backend_session_id(tail_session_id);
                }
            }
        }

        let now = (self.clock)();
        if !success {
            events.push(terminal_status(
                session_id,
                run_id,
                &now,
                DispatchRunState::Failed,
            ));
            return;
        }

        // If the turn ended without a completion event carrying usage, synthesize the
        // estimated signal so a turn always reports its premium request (the real
        // billing unit) — never silently dropped.
        if !run.usage_emitted {
            events.push(BridgeEvent::usage(
                Uuid::new_v4().to_string(),
                session_id,
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
                    session_id,
                    run_id,
                    &now,
                ),
            ));
        }
        events.push(terminal_status(
            session_id,
            run_id,
            &now,
            DispatchRunState::Finalizing,
        ));
        events.push(terminal_status(
            session_id,
            run_id,
            &now,
            DispatchRunState::Completed,
        ));
        // `run` (and its child) drops here, off-lock.
    }
}

fn session_id_from(value: &Value) -> Option<String> {
    ["session_id", "thread_id", "id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

/// A vendor session id from a **completion** event — only the explicit
/// `session_id`/`thread_id` keys, never a generic `id` (which on a completion event
/// is just as likely to be a turn/event id, not the resumable session id).
fn completion_session_id(value: &Value) -> Option<String> {
    ["session_id", "thread_id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

fn estimated_tokens(chars: usize) -> u64 {
    // Ceiling division: any non-empty text estimates to at least one token, so a
    // short prompt/response never reports 0 tok (an estimate of 0 would read as
    // "no usage"). Empty text stays 0.
    (chars.div_ceil(CHARS_PER_TOKEN)) as u64
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

/// Build one terminal status event tagged for this backend (delegates to the shared
/// cross-adapter helper).
fn terminal_status(
    session_id: &str,
    run_id: &str,
    now: &str,
    state: DispatchRunState,
) -> BridgeEvent {
    super::common::terminal_status(AgentBackend::CopilotLocal, session_id, run_id, now, state)
}

/// True if any of these events is a usage signal (the turn's premium-request
/// accounting point).
fn contains_usage(events: &[BridgeEvent]) -> bool {
    events
        .iter()
        .any(|event| matches!(event.payload, crate::wire::BridgeEventPayload::Usage { .. }))
}

/// The outcome of parsing one Copilot JSONL line: events to emit plus the number of
/// assistant-output characters seen (folded into the run's running estimate).
struct ParseResult {
    events: Vec<BridgeEvent>,
    output_chars: usize,
}

/// The run-level estimate state a single `parse_line` call needs: the input-prompt
/// size, the output chars accumulated by prior lines this turn, and whether the
/// turn's usage was already emitted (so a second completion line can't double-count).
struct RunEstimate {
    input_chars: usize,
    output_chars_so_far: usize,
    usage_already_emitted: bool,
}

/// Adopt a vendor session id from a completion event, but only if one is not already
/// captured (a completion event's generic `id` must not clobber the init session id).
fn capture_completion_session_id(value: &Value, backend_session_id: &mut Option<String>) {
    if backend_session_id.is_none() {
        if let Some(id) = completion_session_id(value) {
            *backend_session_id = Some(id);
        }
    }
}

/// Emit a final assembled message and account its size toward the output-token estimate
/// **without double-counting** the deltas that already streamed it: bump the running
/// char count up to the final length only if it exceeds what the deltas accounted for.
/// This is what makes a *final-text-only* response (no deltas) estimate non-zero output
/// tokens.
fn emit_final_text(
    value: &Value,
    output_chars_so_far: usize,
    session_id: &str,
    run_id: &str,
    now: &str,
    result: &mut ParseResult,
) {
    let Some(text) = value.get("text").and_then(Value::as_str) else {
        return;
    };
    if text.is_empty() {
        return;
    }
    result.events.push(agent_message(
        text.to_string(),
        false,
        session_id,
        run_id,
        now,
    ));
    let len = text.chars().count();
    let total = output_chars_so_far + result.output_chars;
    result.output_chars += len.saturating_sub(total);
}

/// Build the per-turn estimated usage event from a completion line's exact
/// premium-request/duration units plus the accumulated character counts.
fn turn_usage_event(
    value: &Value,
    input_chars: usize,
    output_chars: usize,
    session_id: &str,
    run_id: &str,
    now: &str,
) -> BridgeEvent {
    let premium_requests = value
        .get("premium_requests")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let duration_ms = value.get("duration_ms").and_then(Value::as_u64);
    let model = value.get("model").and_then(Value::as_str);
    BridgeEvent::usage(
        Uuid::new_v4().to_string(),
        session_id,
        run_id,
        0,
        now.to_string(),
        estimated_usage_signal(
            UsageEstimate {
                premium_requests,
                duration_ms,
                input_chars,
                output_chars,
                model,
            },
            session_id,
            run_id,
            now,
        ),
    )
}

/// Parse one JSONL line from the Copilot CLI. Token-level `assistant.message_delta`
/// becomes a partial message; a completion event becomes a final message plus the
/// estimated usage signal. Unknown/unparseable lines are ignored.
fn parse_line(
    clock: &EventClock,
    line: &str,
    run_id: &str,
    session_id: &str,
    estimate: RunEstimate,
    backend_session_id: &mut Option<String>,
) -> ParseResult {
    let RunEstimate {
        input_chars,
        output_chars_so_far,
        usage_already_emitted,
    } = estimate;
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
        // The assistant's message ended — surface the final assembled text. This
        // carries NO usage: usage is accounted exactly once per turn, on
        // `turn.completed`.
        "assistant.message_completed" => {
            capture_completion_session_id(&value, backend_session_id);
            emit_final_text(
                &value,
                output_chars_so_far,
                session_id,
                run_id,
                &now,
                &mut result,
            );
        }
        // The turn ended — the single accounting point for the premium request.
        "turn.completed" | "thread.completed" => {
            capture_completion_session_id(&value, backend_session_id);
            // A final assembled message, when this event (rather than a separate
            // `assistant.message_completed`) carries the whole text.
            emit_final_text(
                &value,
                output_chars_so_far,
                session_id,
                run_id,
                &now,
                &mut result,
            );

            // Account usage exactly once per turn: if a prior completion line in this
            // same drain already emitted it, do not emit again (a CLI emitting both
            // `assistant.message_completed`-as-completion and a second `turn.completed`
            // cannot double-count the premium request).
            if !usage_already_emitted {
                result.events.push(turn_usage_event(
                    &value,
                    input_chars,
                    // Include this line's final text in the estimate.
                    output_chars_so_far + result.output_chars,
                    session_id,
                    run_id,
                    &now,
                ));
            }
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

        // A follow-up turn resumes the prior run's captured vendor session; a
        // requested follow-up whose prior run has no captured session id fails
        // explicitly rather than silently degrading into a fresh, context-losing run.
        let resume_session = match request.follow_up_to_run_id.as_deref() {
            Some(prior) => Some(self.backend_session_of(prior).ok_or_else(|| {
                BridgeError::new(
                    "follow_up_session_missing",
                    format!("no vendor session captured for prior run {prior}; cannot resume"),
                )
            })?),
            None => None,
        };

        let mut command = self.exec_command(&request.task, resume_session.as_deref());
        command.current_dir(&request.workspace_root);
        let child = ChildRun::spawn(command, request.session.id.clone(), resume_session)?;
        let process_id = child.process_id();

        self.lock_runs()?.insert(
            run_id.clone(),
            CopilotSlot::live(CopilotRun {
                child,
                input_chars: request.task.chars().count(),
                output_chars: 0,
                usage_emitted: false,
            }),
        );

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
        // A retired (completed) turn has nothing left to stream.
        let Some(run) = slot.as_live_mut() else {
            return Ok(Vec::new());
        };

        let lines = run.child.drain_lines();
        let session_id = run.child.session_id.clone();
        let mut events = Vec::new();
        for line in lines {
            self.account_line(run, run_id, &session_id, &line, &mut events);
        }

        // On process exit, retire under the lock and take ownership of the run, then
        // do the bounded tail drain and the child drop (reader-thread join) **off**
        // the lock so neither blocks another run. The estimate accumulators travel on
        // the owned `CopilotRun`, so the synthesize-if-needed logic runs off-lock too.
        let exit = run.child.poll_exit();
        let retired = if exit.is_some() { slot.retire() } else { None };
        drop(guard);

        if let (Some(success), Some(run)) = (exit, retired) {
            self.finalize_exited_run(success, run_id, &session_id, run, &mut events);
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
        let mut slot = self
            .lock_runs()?
            .remove(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))?;
        if let Some(run) = slot.as_live_mut() {
            run.child.close_and_kill();
        }
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
            CopilotSlot::live(CopilotRun {
                child,
                input_chars: 0,
                output_chars: 0,
                usage_emitted: false,
            }),
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
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
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
            RunEstimate {
                input_chars: 40,
                output_chars_so_far: 400,
                usage_already_emitted: false,
            },
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
    fn message_completed_and_turn_completed_yield_exactly_one_usage() {
        // If a turn produces both `assistant.message_completed` and `turn.completed`,
        // the premium request must be counted exactly once (on turn.completed).
        let mut backend_session = None;
        let count_usage = |parsed: &ParseResult| {
            parsed
                .events
                .iter()
                .filter(|event| {
                    matches!(event.payload, crate::wire::BridgeEventPayload::Usage { .. })
                })
                .count()
        };

        let completed = parse_line(
            &test_clock(),
            r#"{"type":"assistant.message_completed","text":"all done"}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 40,
                output_chars_so_far: 400,
                usage_already_emitted: false,
            },
            &mut backend_session,
        );
        // The message end carries the final text but NO usage.
        assert_eq!(count_usage(&completed), 0);
        assert!(completed
            .events
            .iter()
            .any(|event| matches!(&event.payload,
                crate::wire::BridgeEventPayload::Message { message } if message.body == "all done")));

        let turn = parse_line(
            &test_clock(),
            r#"{"type":"turn.completed","premium_requests":1,"duration_ms":1000}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 40,
                output_chars_so_far: 400,
                usage_already_emitted: false, // not yet emitted
            },
            &mut backend_session,
        );
        // The turn end is the single accounting point: exactly one usage signal.
        assert_eq!(count_usage(&turn), 1);

        // A *second* terminal line in the same drain (usage already emitted) must not
        // double-count the premium request.
        let dup = parse_line(
            &test_clock(),
            r#"{"type":"turn.completed","premium_requests":1,"duration_ms":1000}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 40,
                output_chars_so_far: 400,
                usage_already_emitted: true, // already emitted this run
            },
            &mut backend_session,
        );
        assert_eq!(count_usage(&dup), 0);
    }

    #[test]
    fn final_text_only_response_estimates_nonzero_output_tokens() {
        // A turn that produces a final message but no streamed deltas must still
        // estimate output tokens from the final text (not 0).
        let mut backend_session = None;
        let parsed = parse_line(
            &test_clock(),
            // 12-char text, no prior deltas (output_chars_so_far = 0).
            r#"{"type":"turn.completed","text":"hello world!","premium_requests":1}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
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
        // 12 chars / 4 = 3 estimated output tokens, not 0.
        assert_eq!(usage.output_tokens, Some(3));
    }

    #[test]
    fn completion_event_generic_id_does_not_overwrite_init_session_id() {
        let mut backend_session = None;
        parse_line(
            &test_clock(),
            r#"{"type":"session.created","session_id":"copilot-sess-3"}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
            &mut backend_session,
        );
        parse_line(
            &test_clock(),
            r#"{"type":"turn.completed","id":"turn-9","premium_requests":1}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
            &mut backend_session,
        );
        // The generic `id` on the completion event did not overwrite the session id.
        assert_eq!(backend_session.as_deref(), Some("copilot-sess-3"));
    }

    #[test]
    fn estimated_tokens_round_up_so_short_text_is_never_zero() {
        // Ceiling division: 1..=CHARS_PER_TOKEN chars estimate to 1 token, not 0.
        assert_eq!(estimated_tokens(0), 0);
        assert_eq!(estimated_tokens(1), 1);
        assert_eq!(estimated_tokens(CHARS_PER_TOKEN), 1);
        assert_eq!(estimated_tokens(CHARS_PER_TOKEN + 1), 2);
    }

    #[test]
    fn captures_session_id_for_resume() {
        let mut backend_session = None;
        parse_line(
            &test_clock(),
            r#"{"type":"session.created","session_id":"copilot-sess-3"}"#,
            "run-1",
            "session-1",
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
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
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
            &mut backend_session
        )
        .events
        .is_empty());
        assert!(parse_line(
            &test_clock(),
            r#"{"type":"mystery"}"#,
            "r",
            "s",
            RunEstimate {
                input_chars: 0,
                output_chars_so_far: 0,
                usage_already_emitted: false,
            },
            &mut backend_session
        )
        .events
        .is_empty());
    }

    #[test]
    fn contains_usage_detects_a_usage_event() {
        let usage = turn_usage_event(
            &serde_json::json!({"premium_requests": 1}),
            0,
            0,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
        );
        let message = agent_message(
            "hi".to_string(),
            false,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
        );
        assert!(contains_usage(std::slice::from_ref(&usage)));
        assert!(!contains_usage(std::slice::from_ref(&message)));
        assert!(!contains_usage(&[]));
    }

    #[test]
    fn capture_completion_session_id_only_fills_an_empty_slot() {
        // An explicit session_id fills an empty slot.
        let mut backend_session = None;
        capture_completion_session_id(
            &serde_json::json!({"session_id": "from-completion"}),
            &mut backend_session,
        );
        assert_eq!(backend_session.as_deref(), Some("from-completion"));

        // A second completion (even with a different id) must not clobber it.
        capture_completion_session_id(
            &serde_json::json!({"session_id": "other"}),
            &mut backend_session,
        );
        assert_eq!(backend_session.as_deref(), Some("from-completion"));

        // A generic `id` (turn/event id) is never adopted as the session id.
        let mut empty = None;
        capture_completion_session_id(&serde_json::json!({"id": "turn-9"}), &mut empty);
        assert_eq!(empty, None);
    }

    #[test]
    fn emit_final_text_appends_a_final_message_and_accounts_new_chars() {
        // No prior delta chars: the whole final text counts toward the estimate.
        let mut result = ParseResult {
            events: Vec::new(),
            output_chars: 0,
        };
        emit_final_text(
            &serde_json::json!({"text": "hello world!"}),
            0,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
            &mut result,
        );
        assert_eq!(result.output_chars, 12);
        match &result.events[0].payload {
            crate::wire::BridgeEventPayload::Message { message } => {
                assert_eq!(message.body, "hello world!");
                assert_eq!(message.is_partial, Some(false));
            }
            other => panic!("expected a final message, got {other:?}"),
        }

        // Already-streamed deltas cover the final text: no new chars are double-counted.
        let mut covered = ParseResult {
            events: Vec::new(),
            output_chars: 0,
        };
        emit_final_text(
            &serde_json::json!({"text": "hello world!"}),
            12,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
            &mut covered,
        );
        assert_eq!(covered.output_chars, 0);
        assert_eq!(covered.events.len(), 1);

        // Empty / missing text emits nothing and accounts nothing.
        let mut empty = ParseResult {
            events: Vec::new(),
            output_chars: 0,
        };
        emit_final_text(
            &serde_json::json!({"text": ""}),
            0,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
            &mut empty,
        );
        emit_final_text(
            &serde_json::json!({}),
            0,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
            &mut empty,
        );
        assert!(empty.events.is_empty());
        assert_eq!(empty.output_chars, 0);
    }

    #[test]
    fn turn_usage_event_reads_units_and_estimates_tokens() {
        let event = turn_usage_event(
            &serde_json::json!({
                "premium_requests": 2,
                "duration_ms": 3000,
                "model": "claude-sonnet-4.6"
            }),
            40,
            400,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
        );
        match &event.payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.fidelity, UsageFidelity::Estimated);
                assert_eq!(signal.premium_requests, Some(2));
                assert_eq!(signal.duration_ms, Some(3000));
                assert_eq!(signal.model_label.as_deref(), Some("claude-sonnet-4.6"));
                // 40/4 input, 400/4 output.
                assert_eq!(signal.input_tokens, Some(10));
                assert_eq!(signal.output_tokens, Some(100));
                assert_eq!(signal.total_tokens, Some(110));
                assert_eq!(signal.total_usd, None);
                assert_eq!(signal.backend, AgentBackend::CopilotLocal);
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
    }

    #[test]
    fn turn_usage_event_defaults_premium_requests_to_one() {
        let event = turn_usage_event(
            &serde_json::json!({}),
            0,
            0,
            "session-1",
            "run-1",
            "2026-06-08T12:00:00Z",
        );
        match &event.payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.premium_requests, Some(1));
                assert_eq!(signal.duration_ms, None);
                assert_eq!(signal.model_label, None);
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
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
    fn follow_up_to_unknown_run_fails_instead_of_starting_fresh() {
        let adapter = CopilotLocalAdapter::new("copilot", test_clock());
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                pinned: false,
                id: "s1".to_string(),
                backend: AgentBackend::CopilotLocal,
                title: "t".to_string(),
                workspace_root: ".".to_string(),
                created_at: "2026-06-08T12:00:00Z".to_string(),
                updated_at: "2026-06-08T12:00:00Z".to_string(),
                current_run_id: None,
            },
            workspace_root: ".".to_string(),
            task: "continue".to_string(),
            model: None,
            agent: None,
            effort: None,
            requested_run_id: Some("run-2".to_string()),
            follow_up_to_run_id: Some("does-not-exist".to_string()),
            transcript: Vec::new(),
            launch_command: None,
            attachments: Vec::new(),
        };
        let error = adapter
            .start(request)
            .expect_err("follow-up with no captured session fails");
        assert_eq!(error.code, "follow_up_session_missing");
    }

    #[test]
    fn failed_launch_reports_backend_unavailable() {
        let adapter =
            CopilotLocalAdapter::new("definitely-not-a-real-copilot-binary-xyz", test_clock());
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                pinned: false,
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
            model: None,
            agent: None,
            effort: None,
            requested_run_id: Some("run-1".to_string()),
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: None,
            attachments: Vec::new(),
        };
        let error = adapter.start(request).expect_err("missing binary fails");
        assert_eq!(error.code, "backend_unavailable");
    }
}
