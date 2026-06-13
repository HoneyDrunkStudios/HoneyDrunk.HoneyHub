//! `codex.local` adapter — drives the official Codex CLI under the user's own
//! local (ChatGPT) session (ADR-0090 D2/D10; ADR-0092 D2; packet 09 §3a).
//!
//! Codex differs from `claude.local` in three ways that shape this adapter:
//!
//! 1. **Resume-based, not same-process.** A Codex turn is a non-interactive
//!    `codex exec` process that runs to completion. There is no open stdin to write
//!    a follow-up into, so `interactive_reply` is `false`; the core routes a reply
//!    through the **follow-up-run path** (a fresh `start` with `follow_up_to_run_id`
//!    set), which this adapter turns into a `codex exec resume <session>` launch.
//! 2. **Message-level streaming.** Codex emits structured `item.completed` events
//!    (a whole agent message at a time), not token deltas.
//! 3. **Exact tokens, no USD.** The dollar value is **derived** from the
//!    operator-configurable rate table (ADR-0092 D2 / ADR-0052 D2 / ADR-0016 D5),
//!    not reported by the CLI. The rate lookup is **injected** so the bridge crate
//!    never hardcodes vendor prices and the host decides the rate source; with no
//!    rate configured, token counts stay exact and USD is simply absent (shown as
//!    unknown), never fabricated.
//!
//! All child-process mechanics live in the shared [`super::child_run`] driver; this
//! module is the Codex strategy: the command, the capability flags, the JSONL
//! parsing, and the resume wiring.
//!
//! NOTE (packet 09 §3a re-scope): the exact `codex exec --json` command shape is the
//! spike's best-known invocation and is isolated to [`CodexLocalAdapter::exec_command`]
//! so the live-CLI dogfood can correct it in one place. Everything below it — parsing,
//! fidelity, follow-up wiring — is independent of the precise flags and is covered by
//! the `fake_codex` integration fixture.

use crate::adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
use crate::adapters::child_run::{ChildRun, EventClock, RunSlot};
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

/// Computes a **derived** USD cost from a model label + exact token counts by
/// reading the operator-configurable rate table (ADR-0092 D2 / ADR-0052 D2 / ADR-0016
/// D5). Injected so the bridge crate never hardcodes vendor prices and the host owns
/// the rate source. Returns `None` when no rate is configured for the model — the
/// token counts remain exact and the cost is shown as unknown rather than guessed.
///
/// (Kept local to this adapter for now; it lifts to a shared cost module once the
/// cost-display and routing work add a second consumer of the rate surface.)
pub type UsdRateLookup = Arc<dyn Fn(&str, u64, u64) -> Option<f64> + Send + Sync>;

/// The default lookup: no rate table wired, so USD is always absent (tokens exact).
pub fn no_rate_lookup() -> UsdRateLookup {
    Arc::new(|_model, _input, _output| None)
}

/// The `codex.local` backend adapter. Methods take `&self` (the trait contract), so
/// the live child processes live behind a `Mutex` for interior mutability.
pub struct CodexLocalAdapter {
    program: String,
    clock: EventClock,
    rate_lookup: UsdRateLookup,
    runs: Mutex<HashMap<String, RunSlot>>,
}

impl CodexLocalAdapter {
    /// Build an adapter that launches `program` (normally `"codex"`; a fake binary
    /// path under test) with the given clock and **no** rate table (USD absent).
    pub fn new(program: impl Into<String>, clock: EventClock) -> Self {
        Self::with_rate_lookup(program, clock, no_rate_lookup())
    }

    /// Build an adapter with an injected rate lookup so `result` token counts gain a
    /// derived USD figure (ADR-0092 D2).
    pub fn with_rate_lookup(
        program: impl Into<String>,
        clock: EventClock,
        rate_lookup: UsdRateLookup,
    ) -> Self {
        Self {
            program: program.into(),
            clock,
            rate_lookup,
            runs: Mutex::new(HashMap::new()),
        }
    }

    fn lock_runs(&self) -> Result<MutexGuard<'_, HashMap<String, RunSlot>>, BridgeError> {
        self.runs
            .lock()
            .map_err(|_| BridgeError::new("lock_poisoned", "codex adapter lock was poisoned"))
    }

    /// Build the `codex exec` command for one turn. A fresh turn runs
    /// `codex exec --json <task>`; a resumed turn runs
    /// `codex exec --json resume <session> <task>`.
    ///
    /// The `--json` option goes **immediately after `exec`, before the `resume`
    /// subcommand**, which is the shape the official CLI requires for reliable
    /// non-interactive resume + JSON output. This is the single CLI-shape-dependent
    /// surface (packet 09 §3a re-scope point); everything else in this module is
    /// independent of the precise flags.
    fn exec_command(&self, task: &str, resume_session: Option<&str>) -> Command {
        let mut command = Command::new(&self.program);
        command.arg("exec").arg("--json");
        if let Some(session) = resume_session {
            command.arg("resume").arg(session);
        }
        if !task.is_empty() {
            command.arg(task);
        }
        command
    }

    /// The backend (vendor) session id of a prior run, used to resume it on a
    /// follow-up turn. Returns `None` if the prior run is gone or never reported one.
    fn backend_session_of(&self, run_id: &str) -> Option<String> {
        self.lock_runs().ok().and_then(|guard| {
            guard
                .get(run_id)
                .and_then(|slot| slot.backend_session_id().map(str::to_string))
        })
    }

    /// Off-lock finalization for an exited turn: drain the child's final lines (the
    /// closing `turn.completed` usage line), carry any tail-discovered vendor session
    /// id back to the retired slot, then push the terminal transition.
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
                    &self.rate_lookup,
                    &line,
                    run_id,
                    session_id,
                    &mut child.backend_session_id,
                ));
            }
            tail_session_id = child.backend_session_id.clone();
        }

        // Carry a vendor session id discovered only in the drained tail back to the
        // retired slot so a later follow-up resume still sees it.
        if tail_session_id.is_some() {
            if let Ok(mut guard) = self.lock_runs() {
                if let Some(slot) = guard.get_mut(run_id) {
                    slot.set_done_backend_session_id(tail_session_id);
                }
            }
        }

        let now = (self.clock)();
        push_terminal_status(events, success, session_id, run_id, &now);
    }
}

/// Pull a vendor session id out of an **init**-style event (`thread.started` /
/// `session.created`), accepting the field names Codex may use there
/// (`thread_id` / `session_id` / `id`).
fn session_id_from(value: &Value) -> Option<String> {
    ["thread_id", "session_id", "id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

/// Pull a vendor session id out of a **completion**-style event
/// (`turn.completed` / `thread.completed`). Only the explicit `thread_id` /
/// `session_id` keys are accepted — a generic `id` on a completion event is just as
/// likely to be a turn/event id, which must not be mistaken for the resumable
/// session id captured at init.
fn completion_session_id(value: &Value) -> Option<String> {
    ["thread_id", "session_id"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::to_string)
}

/// Extract the agent message text from a completed item, accepting `text` or a
/// content-array shape.
fn item_text(item: &Value) -> String {
    if let Some(Value::String(text)) = item.get("text") {
        return text.clone();
    }
    match item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// True for the item types that are a user-visible agent message (vs. internal
/// reasoning / tool-call items, which v1 does not surface).
fn is_agent_message_item(item_type: &str) -> bool {
    matches!(item_type, "agent_message" | "assistant_message" | "message")
}

fn derived_usage_signal(
    usage: &Value,
    model: Option<&str>,
    rate: &UsdRateLookup,
    session_id: &str,
    run_id: &str,
    now: &str,
) -> UsageSignal {
    let token_field = |name: &str| usage.get(name).and_then(Value::as_u64);
    let input_tokens = token_field("input_tokens");
    let output_tokens = token_field("output_tokens");
    let total_tokens = if input_tokens.is_some() || output_tokens.is_some() {
        Some(input_tokens.unwrap_or(0) + output_tokens.unwrap_or(0))
    } else {
        None
    };
    // Tokens are exact; USD is derived from the injected rate table (ADR-0092 D2).
    // With no rate configured the cost is absent — never fabricated.
    let total_usd = match (model, input_tokens, output_tokens) {
        (Some(model), Some(input), Some(output)) => (rate)(model, input, output),
        _ => None,
    };
    UsageSignal {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        backend: AgentBackend::CodexLocal,
        fidelity: UsageFidelity::Derived,
        model_label: model.map(str::to_string),
        input_tokens,
        output_tokens,
        total_tokens,
        total_usd,
        premium_requests: None,
        duration_ms: usage.get("duration_ms").and_then(Value::as_u64),
        // Derived from a rate table whose freshness the adapter cannot verify here.
        confidence: Some(UsageConfidence::Medium),
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
            backend: AgentBackend::CodexLocal,
            repo_hint: None,
            link: None,
        },
    )
}

/// Push the terminal transition (clean exit finalizes then completes; a non-zero exit
/// fails) after the tail usage line.
fn push_terminal_status(
    events: &mut Vec<BridgeEvent>,
    success: bool,
    session_id: &str,
    run_id: &str,
    now: &str,
) {
    if success {
        events.push(terminal_status(
            session_id,
            run_id,
            now,
            DispatchRunState::Finalizing,
        ));
        events.push(terminal_status(
            session_id,
            run_id,
            now,
            DispatchRunState::Completed,
        ));
    } else {
        events.push(terminal_status(
            session_id,
            run_id,
            now,
            DispatchRunState::Failed,
        ));
    }
}

/// Parse one JSONL line from `codex exec --json` into zero or more `BridgeEvent`s.
/// Unknown or unparseable lines are ignored (never fabricated into a stream).
fn parse_line(
    clock: &EventClock,
    rate: &UsdRateLookup,
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
        // Init: capture the vendor session/thread id so a later turn can resume it.
        "thread.started" | "session.created" | "session.configured" => {
            if let Some(id) = session_id_from(&value) {
                *backend_session_id = Some(id);
            }
            Vec::new()
        }
        // A completed item — surface agent messages, ignore reasoning/tool items.
        "item.completed" => {
            let item = value.get("item").unwrap_or(&Value::Null);
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if !is_agent_message_item(item_type) {
                return Vec::new();
            }
            let body = item_text(item);
            if body.is_empty() {
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
                    body,
                    created_at: now,
                    // Codex streams whole messages (item.completed), not partials.
                    is_partial: Some(false),
                },
            )]
        }
        // Turn finished — carries the exact token usage for the derived signal.
        "turn.completed" | "thread.completed" => {
            // Only adopt a session id from explicit `thread_id`/`session_id` keys, and
            // never overwrite the one captured at init — a completion event's generic
            // `id` is likely a turn/event id, not the resumable session id.
            if backend_session_id.is_none() {
                if let Some(id) = completion_session_id(&value) {
                    *backend_session_id = Some(id);
                }
            }
            let Some(usage) = value.get("usage") else {
                return Vec::new();
            };
            let model = value.get("model").and_then(Value::as_str);
            vec![BridgeEvent::usage(
                Uuid::new_v4().to_string(),
                session_id,
                run_id,
                0,
                now.clone(),
                derived_usage_signal(usage, model, rate, session_id, run_id, &now),
            )]
        }
        _ => Vec::new(),
    }
}

impl AgentBackendAdapter for CodexLocalAdapter {
    fn backend(&self) -> AgentBackend {
        AgentBackend::CodexLocal
    }

    fn capabilities(&self) -> CapabilityFlags {
        CapabilityFlags::codex_local()
    }

    fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
        let run_id = request
            .requested_run_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        // A follow-up turn (the core's resume-based reply path) resumes the prior
        // run's vendor session; a fresh turn starts a new Codex thread. A requested
        // follow-up whose prior run has no captured vendor session id fails
        // explicitly rather than silently degrading into a fresh, context-losing
        // `codex exec`.
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
        let run = ChildRun::spawn(command, request.session.id.clone(), resume_session)?;
        let process_id = run.process_id();

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
        // A retired (completed) turn has nothing left to stream.
        let Some(run) = slot.as_live_mut() else {
            return Ok(Vec::new());
        };

        let lines = run.drain_lines();
        let session_id = run.session_id.clone();
        let mut events = Vec::new();
        for line in lines {
            events.extend(parse_line(
                &self.clock,
                &self.rate_lookup,
                &line,
                run_id,
                &session_id,
                &mut run.backend_session_id,
            ));
        }

        // A Codex `exec` turn runs to completion, so observing exit ends the turn.
        // Retire under the lock (the vendor session id was captured early, from
        // `thread.started`/`session.created`) and take ownership of the child, then
        // do the bounded tail drain and the child drop (reader-thread join) **off**
        // the lock so neither blocks another run's `stream`/`reply`/`stop`.
        let exit = run.poll_exit();
        let retired = if exit.is_some() { slot.retire() } else { None };
        drop(guard);

        if let Some(success) = exit {
            self.finalize_exited_run(success, run_id, &session_id, retired, &mut events);
        }

        Ok(events)
    }

    fn reply(&self, _run_id: &str, _text: &str) -> Result<(), BridgeError> {
        // Codex is resume-based: the core checks `interactive_reply` (false) and
        // routes replies through the follow-up-run path (a fresh `start` with
        // `follow_up_to_run_id`), so this is never reached in normal flow. Fail
        // honestly if a caller bypasses the capability gate.
        Err(BridgeError::new(
            "reply_unavailable",
            "codex is resume-based; replies route through a follow-up run",
        ))
    }

    fn stop(&self, run_id: &str) -> Result<(), BridgeError> {
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
        let command = self.exec_command("", Some(session_id_or_transcript));
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

    fn test_clock() -> EventClock {
        Arc::new(|| "2026-06-08T12:00:00Z".to_string())
    }

    fn command_args(command: &std::process::Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn fresh_command_puts_json_after_exec() {
        let adapter = CodexLocalAdapter::new("codex", test_clock());
        let command = adapter.exec_command("do it", None);
        assert_eq!(command_args(&command), ["exec", "--json", "do it"]);
    }

    #[test]
    fn resumed_command_puts_json_before_the_resume_subcommand() {
        // Regression: `--json` must come immediately after `exec`, before `resume`.
        let adapter = CodexLocalAdapter::new("codex", test_clock());
        let command = adapter.exec_command("continue", Some("sess-1"));
        assert_eq!(
            command_args(&command),
            ["exec", "--json", "resume", "sess-1", "continue"]
        );
    }

    #[test]
    fn declares_spike_observed_capabilities() {
        let adapter = CodexLocalAdapter::new("codex", test_clock());
        let capabilities = adapter.capabilities();

        assert!(capabilities.streaming_output);
        // Resume-based, not same-process live reply.
        assert!(!capabilities.interactive_reply);
        assert!(capabilities.resume_session);
        assert!(capabilities.stop_signal);
        assert!(capabilities.structured_events);
        // Exact tokens, derived USD.
        assert!(!capabilities.usage_exact);
        assert!(capabilities.usage_derived);
        assert!(!capabilities.usage_estimated);
        assert_eq!(adapter.backend(), AgentBackend::CodexLocal);
    }

    #[test]
    fn captures_session_then_surfaces_agent_message() {
        let mut backend_session = None;
        let rate = no_rate_lookup();

        let init = parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"thread.started","thread_id":"codex-thread-7","model":"codex-fake"}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert!(init.is_empty());
        assert_eq!(backend_session.as_deref(), Some("codex-thread-7"));

        let message = parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &message[0].payload {
            crate::wire::BridgeEventPayload::Message { message } => {
                assert_eq!(message.body, "hello from codex");
                assert_eq!(message.is_partial, Some(false));
            }
            other => panic!("expected a message payload, got {other:?}"),
        }
    }

    #[test]
    fn completion_event_generic_id_does_not_overwrite_init_session_id() {
        // A `turn.completed` carrying a generic `id` (a turn/event id) must not
        // clobber the resumable session id captured from `thread.started`.
        let mut backend_session = None;
        let rate = no_rate_lookup();
        parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"thread.started","thread_id":"codex-thread-7"}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert_eq!(backend_session.as_deref(), Some("codex-thread-7"));

        parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"turn.completed","id":"turn-99","usage":{"input_tokens":10,"output_tokens":5}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        // Still the thread id, not "turn-99".
        assert_eq!(backend_session.as_deref(), Some("codex-thread-7"));
    }

    #[test]
    fn ignores_reasoning_items() {
        let mut backend_session = None;
        let events = parse_line(
            &test_clock(),
            &no_rate_lookup(),
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        assert!(events.is_empty());
    }

    #[test]
    fn turn_completed_yields_exact_tokens_with_absent_usd_when_no_rate() {
        let mut backend_session = None;
        let events = parse_line(
            &test_clock(),
            &no_rate_lookup(),
            r#"{"type":"turn.completed","model":"codex-fake","usage":{"input_tokens":100,"output_tokens":50}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.fidelity, UsageFidelity::Derived);
                assert_eq!(signal.input_tokens, Some(100));
                assert_eq!(signal.output_tokens, Some(50));
                assert_eq!(signal.total_tokens, Some(150));
                // No rate table wired -> tokens exact, USD absent (never fabricated).
                assert_eq!(signal.total_usd, None);
                assert_eq!(signal.backend, AgentBackend::CodexLocal);
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
    }

    #[test]
    fn turn_completed_derives_usd_from_injected_rate() {
        let mut backend_session = None;
        // A toy rate: $1 per 1000 input + $2 per 1000 output tokens.
        let rate: UsdRateLookup = Arc::new(|_model, input, output| {
            Some(input as f64 / 1000.0 + (output as f64 / 1000.0) * 2.0)
        });
        let events = parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"turn.completed","model":"codex-fake","usage":{"input_tokens":1000,"output_tokens":1000}}"#,
            "run-1",
            "session-1",
            &mut backend_session,
        );
        match &events[0].payload {
            crate::wire::BridgeEventPayload::Usage { signal } => {
                assert_eq!(signal.fidelity, UsageFidelity::Derived);
                // 1.0 (input) + 2.0 (output)
                assert_eq!(signal.total_usd, Some(3.0));
            }
            other => panic!("expected a usage payload, got {other:?}"),
        }
    }

    #[test]
    fn ignores_unparseable_and_unknown_lines() {
        let mut backend_session = None;
        let rate = no_rate_lookup();
        assert!(parse_line(
            &test_clock(),
            &rate,
            "not json",
            "r",
            "s",
            &mut backend_session
        )
        .is_empty());
        assert!(parse_line(
            &test_clock(),
            &rate,
            r#"{"type":"mystery"}"#,
            "r",
            "s",
            &mut backend_session
        )
        .is_empty());
    }

    #[test]
    fn reply_is_unavailable_resume_based() {
        let adapter = CodexLocalAdapter::new("codex", test_clock());
        let error = adapter
            .reply("run-1", "continue")
            .expect_err("codex reply is resume-based");
        assert_eq!(error.code, "reply_unavailable");
    }

    #[test]
    fn follow_up_to_unknown_run_fails_instead_of_starting_fresh() {
        // A follow-up whose prior run has no captured vendor session must error,
        // never silently degrade into a context-losing fresh `codex exec`.
        let adapter = CodexLocalAdapter::new("codex", test_clock());
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                id: "s1".to_string(),
                backend: AgentBackend::CodexLocal,
                title: "t".to_string(),
                workspace_root: ".".to_string(),
                created_at: "2026-06-08T12:00:00Z".to_string(),
                updated_at: "2026-06-08T12:00:00Z".to_string(),
                current_run_id: None,
            },
            workspace_root: ".".to_string(),
            task: "continue".to_string(),
            requested_run_id: Some("run-2".to_string()),
            follow_up_to_run_id: Some("does-not-exist".to_string()),
            transcript: Vec::new(),
            launch_command: None,
        };
        let error = adapter
            .start(request)
            .expect_err("follow-up with no captured session fails");
        assert_eq!(error.code, "follow_up_session_missing");
    }

    #[test]
    fn failed_launch_reports_backend_unavailable() {
        let adapter =
            CodexLocalAdapter::new("definitely-not-a-real-codex-binary-xyz", test_clock());
        let request = StartRunRequest {
            session: crate::session::DispatchSession {
                id: "s1".to_string(),
                backend: AgentBackend::CodexLocal,
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
