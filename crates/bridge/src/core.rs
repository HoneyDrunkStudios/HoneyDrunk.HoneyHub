use crate::adapter::{AgentBackend, AgentBackendAdapter, BridgeError, RunHandle, StartRunRequest};
use crate::agents::{discover_raw_global_in, discover_raw_in_root, merge_agents, AgentDefinition};
use crate::artifact::DispatchArtifact;
use crate::coaching::{coach, CoachingSnapshot};
use crate::pairing::{BackendAllowlist, WorkspaceAllowlist};
use crate::process::{ProcessExitStatus, ProcessHandle};
use crate::session::{
    DispatchControlEvent, DispatchControlEventKind, DispatchMessage, DispatchRun,
    DispatchRunRecord, DispatchRunState, DispatchSession, PolicyHint, UsageSignal, UsageSummary,
};
use crate::wire::{BridgeEvent, BridgeEventPayload, ReconnectRequest};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyOutcome {
    LiveReplyAccepted,
    FollowUpRunStarted(RunHandle),
}

#[derive(Debug, Clone)]
pub struct ManagedRun {
    pub session: DispatchSession,
    pub workspace_root: String,
    pub record: DispatchRunRecord,
    pub process: ProcessHandle,
    pub transcript: Vec<DispatchMessage>,
    pub event_log: Vec<BridgeEvent>,
    pub artifacts: Vec<DispatchArtifact>,
}

pub struct BridgeRuntime<A>
where
    A: AgentBackendAdapter,
{
    adapter: A,
    workspace_allowlist: WorkspaceAllowlist,
    backend_allowlist: BackendAllowlist,
    /// Parent of the user-global agent folders (`~/.claude/agents`, `~/.copilot/agents`).
    /// Resolved from the environment by default; `None` disables global agent discovery.
    /// Injectable so tests pin it to a temp dir instead of the developer's real home.
    global_home: Option<PathBuf>,
    runs: HashMap<String, ManagedRun>,
}

impl<A> BridgeRuntime<A>
where
    A: AgentBackendAdapter,
{
    pub fn new(
        adapter: A,
        workspace_allowlist: WorkspaceAllowlist,
        backend_allowlist: BackendAllowlist,
    ) -> Self {
        Self {
            adapter,
            workspace_allowlist,
            backend_allowlist,
            // Global discovery is **opt-in, off by default**: reading the user-global
            // `~/.claude/agents` / `~/.copilot/agents` is outside the workspace allowlist,
            // so the runtime does not do it unless the host explicitly enables it via
            // `with_global_home` (ADR-0090 keeps discovery within configured roots).
            global_home: None,
            runs: HashMap::new(),
        }
    }

    /// Opt **in** to user-global agent discovery by setting the home directory whose
    /// `~/.claude/agents` / `~/.copilot/agents` folders should be scanned (resolve it
    /// dependency-free with [`user_home`]). This reads outside the workspace allowlist —
    /// the user's own home config — so it is deliberately not enabled by default; the host
    /// turns it on explicitly. `None` (the default) disables it. Tests pin it to a temp dir.
    pub fn with_global_home(mut self, global_home: Option<PathBuf>) -> Self {
        self.global_home = global_home;
        self
    }

    pub fn start(
        &mut self,
        mut request: StartRunRequest,
        created_at: impl Into<String>,
    ) -> Result<RunHandle, BridgeError> {
        let created_at = created_at.into();
        self.ensure_backend_allowed()?;
        self.ensure_workspace_allowed(&request.workspace_root)?;
        self.ensure_request_workspace_matches(&request)?;
        if request.requested_run_id.is_none() {
            request.requested_run_id = Some(Uuid::new_v4().to_string());
        }
        if let Some(requested_run_id) = &request.requested_run_id {
            self.ensure_run_id_available(requested_run_id)?;
        }
        if request.session.backend != self.adapter.backend() {
            return Err(BridgeError::new(
                "backend_mismatch",
                "request backend does not match bridge adapter",
            ));
        }

        let handle = self.adapter.start(request.clone())?;
        self.ensure_run_id_available(&handle.run_id)?;
        let mut record = DispatchRunRecord::new(DispatchRun::new(
            handle.run_id.clone(),
            request.session.id.clone(),
            request.task.clone(),
        ));
        let control_events = vec![
            record.transition_to(DispatchRunState::Queued, created_at.clone())?,
            record.transition_to(DispatchRunState::Starting, created_at.clone())?,
            record.append_event(
                DispatchControlEventKind::Launch,
                created_at.clone(),
                "launch recorded",
            )?,
            record.transition_to(DispatchRunState::Running, created_at.clone())?,
        ];

        let process = ProcessHandle::launched(
            handle.run_id.clone(),
            handle.process_id,
            request.launch_command.clone().unwrap_or_default(),
            created_at.clone(),
        );
        self.runs.insert(
            handle.run_id.clone(),
            ManagedRun {
                session: request.session,
                workspace_root: request.workspace_root,
                record,
                process,
                transcript: request.transcript,
                event_log: Self::control_events_to_bridge_events(control_events),
                artifacts: Vec::new(),
            },
        );

        Ok(handle)
    }

    pub fn stream_events(&mut self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
        if !self.adapter.capabilities().streaming_output {
            return Err(BridgeError::new(
                "unsupported_capability",
                "backend adapter does not declare streaming_output",
            ));
        }
        let session_id = self.run(run_id)?.session.id.clone();

        let events = self.adapter.stream(run_id)?;
        for event in &events {
            self.validate_stream_event(event, run_id, &session_id)?;
        }

        for event in &events {
            match &event.payload {
                BridgeEventPayload::Message { message } => {
                    self.run_mut(run_id)?.transcript.push(message.clone());
                }
                BridgeEventPayload::Control { event } => {
                    self.run_mut(run_id)?
                        .record
                        .control_events
                        .push(event.clone());
                }
                BridgeEventPayload::Status { status } => {
                    self.transition_run(run_id, status.state.clone(), event.created_at.clone())?;
                }
                BridgeEventPayload::Artifact { artifact } => {
                    self.run_mut(run_id)?.artifacts.push(artifact.clone());
                }
                _ => {}
            }
            let managed = self.run_mut(run_id)?;
            Self::push_bridge_event(managed, event.clone());
        }
        Ok(events)
    }

    pub fn reply(
        &mut self,
        run_id: &str,
        text: &str,
        created_at: impl Into<String>,
    ) -> Result<ReplyOutcome, BridgeError> {
        let created_at = created_at.into();
        let current = self.run(run_id)?.record.run.state.clone();
        let capabilities = self.adapter.capabilities();
        if current.is_terminal() {
            // A resume-based backend (interactive_reply = false + resume_session) can
            // continue a **cleanly completed** turn by starting a follow-up run that
            // resumes the vendor session, so a `Completed` run is a valid reply target
            // there. Every other case is rejected: an interactive backend cannot write
            // into an exited process, and a run that ended in `Failed`/`Cancelled`/
            // `Stopped` is not a sound base to resume from (the session may be broken
            // or was intentionally torn down).
            let resumable_completed = current == DispatchRunState::Completed
                && !capabilities.interactive_reply
                && capabilities.resume_session;
            if !resumable_completed {
                return Err(BridgeError::new(
                    "terminal_run_reply",
                    format!("cannot reply to terminal run {run_id} in state {current:?}"),
                ));
            }
        }
        if capabilities.interactive_reply {
            self.adapter.reply(run_id, text)?;
            let managed = self.run_mut(run_id)?;
            if managed.record.run.state == DispatchRunState::NeedsInput {
                let event = managed
                    .record
                    .transition_to(DispatchRunState::Running, created_at.clone())?;
                Self::push_control_bridge_event(managed, event);
            }
            let event = managed.record.append_event(
                DispatchControlEventKind::Reply,
                created_at,
                "interactive reply accepted",
            )?;
            Self::push_control_bridge_event(managed, event);
            return Ok(ReplyOutcome::LiveReplyAccepted);
        }

        let (session, workspace_root, transcript) = {
            let managed = self.run(run_id)?;
            (
                managed.session.clone(),
                managed.workspace_root.clone(),
                managed.transcript.clone(),
            )
        };
        let request = StartRunRequest {
            session,
            workspace_root,
            task: text.to_string(),
            requested_run_id: Some(Uuid::new_v4().to_string()),
            follow_up_to_run_id: Some(run_id.to_string()),
            transcript,
            launch_command: None,
        };
        if let Some(requested_run_id) = &request.requested_run_id {
            self.ensure_run_id_available(requested_run_id)?;
        }
        let handle = self.adapter.start(request.clone())?;
        self.ensure_run_id_available(&handle.run_id)?;

        {
            let original = self.run_mut(run_id)?;
            if original.record.run.state == DispatchRunState::NeedsInput {
                let event = original
                    .record
                    .transition_to(DispatchRunState::Finalizing, created_at.clone())?;
                Self::push_control_bridge_event(original, event);
                let event = original
                    .record
                    .transition_to(DispatchRunState::Completed, created_at.clone())?;
                Self::push_control_bridge_event(original, event);
            }
            let event = original.record.append_event(
                DispatchControlEventKind::FollowUp,
                created_at.clone(),
                "reply routed to follow-up run",
            )?;
            Self::push_control_bridge_event(original, event);
        }

        let mut record = DispatchRunRecord::new(DispatchRun::new(
            handle.run_id.clone(),
            request.session.id.clone(),
            request.task.clone(),
        ));
        let control_events = vec![
            record.transition_to(DispatchRunState::Queued, created_at.clone())?,
            record.transition_to(DispatchRunState::Starting, created_at.clone())?,
            record.append_event(
                DispatchControlEventKind::Launch,
                created_at.clone(),
                "follow-up launch recorded",
            )?,
            record.transition_to(DispatchRunState::Running, created_at.clone())?,
        ];

        self.runs.insert(
            handle.run_id.clone(),
            ManagedRun {
                session: request.session,
                workspace_root: request.workspace_root,
                record,
                process: ProcessHandle::launched(
                    handle.run_id.clone(),
                    handle.process_id,
                    request.launch_command.unwrap_or_default(),
                    created_at,
                ),
                transcript: request.transcript,
                event_log: Self::control_events_to_bridge_events(control_events),
                artifacts: Vec::new(),
            },
        );

        Ok(ReplyOutcome::FollowUpRunStarted(handle))
    }

    pub fn stop(&mut self, run_id: &str, created_at: impl Into<String>) -> Result<(), BridgeError> {
        let created_at = created_at.into();
        if !self.adapter.capabilities().stop_signal {
            return Err(BridgeError::new(
                "unsupported_capability",
                "backend adapter does not declare stop_signal",
            ));
        }
        let current = self.run(run_id)?.record.run.state.clone();
        if !current.can_transition_to(&DispatchRunState::Stopping) {
            return Err(BridgeError::new(
                "invalid_state_transition",
                format!("cannot transition run {run_id} from {current:?} to Stopping"),
            ));
        }

        self.adapter.stop(run_id)?;
        let managed = self.run_mut(run_id)?;
        let event = managed
            .record
            .transition_to(DispatchRunState::Stopping, created_at.clone())?;
        Self::push_control_bridge_event(managed, event);
        let event = managed.record.append_event(
            DispatchControlEventKind::Stop,
            created_at,
            "stop requested",
        )?;
        Self::push_control_bridge_event(managed, event);
        Ok(())
    }

    pub fn handle_stop_timeout(
        &mut self,
        run_id: &str,
        created_at: impl Into<String>,
    ) -> Result<(), BridgeError> {
        let created_at = created_at.into();
        let managed = self.run_mut(run_id)?;
        if managed.record.run.state != DispatchRunState::Stopping {
            return Err(BridgeError::new(
                "invalid_stop_timeout",
                "stop timeout can only be recorded while a run is stopping",
            ));
        }

        let event = managed.record.append_event(
            DispatchControlEventKind::Timeout,
            created_at.clone(),
            "graceful stop timed out; escalated to failed",
        )?;
        Self::push_control_bridge_event(managed, event);
        managed.record.run.failure_reason = Some("graceful stop timed out".to_string());
        let event = managed
            .record
            .transition_to(DispatchRunState::Failed, created_at)?;
        Self::push_control_bridge_event(managed, event);
        Ok(())
    }

    pub fn handle_process_exit(
        &mut self,
        run_id: &str,
        exit: ProcessExitStatus,
    ) -> Result<(), BridgeError> {
        if exit.run_id != run_id {
            return Err(BridgeError::new(
                "process_exit_run_mismatch",
                "process exit status run id does not match the target run",
            ));
        }

        let managed = self.run_mut(run_id)?;
        if managed.record.run.state.is_terminal() {
            let event = managed.record.append_event(
                DispatchControlEventKind::ProcessExit,
                exit.exited_at,
                "process exit recorded after terminal state",
            )?;
            Self::push_control_bridge_event(managed, event);
            return Ok(());
        }

        if exit.success {
            match managed.record.run.state {
                DispatchRunState::Stopping => {
                    let event = managed
                        .record
                        .transition_to(DispatchRunState::Cancelled, exit.exited_at.clone())?;
                    Self::push_control_bridge_event(managed, event);
                }
                DispatchRunState::Finalizing => {
                    let event = managed
                        .record
                        .transition_to(DispatchRunState::Completed, exit.exited_at.clone())?;
                    Self::push_control_bridge_event(managed, event);
                }
                _ => {
                    let event = managed
                        .record
                        .transition_to(DispatchRunState::Finalizing, exit.exited_at.clone())?;
                    Self::push_control_bridge_event(managed, event);
                    let event = managed
                        .record
                        .transition_to(DispatchRunState::Completed, exit.exited_at.clone())?;
                    Self::push_control_bridge_event(managed, event);
                }
            }
        } else {
            managed.record.run.failure_reason = Some(exit.summary());
            let event = managed
                .record
                .transition_to(DispatchRunState::Failed, exit.exited_at.clone())?;
            Self::push_control_bridge_event(managed, event);
        }
        let event = managed.record.append_event(
            DispatchControlEventKind::ProcessExit,
            exit.exited_at,
            "process exit recorded",
        )?;
        Self::push_control_bridge_event(managed, event);
        Ok(())
    }

    fn validate_stream_event(
        &self,
        event: &BridgeEvent,
        expected_run_id: &str,
        expected_session_id: &str,
    ) -> Result<(), BridgeError> {
        if event.run_id != expected_run_id {
            return Err(BridgeError::new(
                "event_run_mismatch",
                "stream event run id does not match requested run",
            ));
        }
        if event.session_id != expected_session_id {
            return Err(BridgeError::new(
                "event_session_mismatch",
                "stream event session id does not match managed run session",
            ));
        }

        match &event.payload {
            BridgeEventPayload::Message { message } => {
                if message.run_id != event.run_id || message.session_id != event.session_id {
                    return Err(BridgeError::new(
                        "event_message_mismatch",
                        "stream message ids do not match containing event",
                    ));
                }
            }
            BridgeEventPayload::Control { event: control } => {
                if control.run_id != event.run_id || control.session_id != event.session_id {
                    return Err(BridgeError::new(
                        "event_control_mismatch",
                        "stream control event ids do not match containing event",
                    ));
                }
            }
            BridgeEventPayload::Usage { signal } => {
                if signal.run_id != event.run_id || signal.session_id != event.session_id {
                    return Err(BridgeError::new(
                        "event_usage_mismatch",
                        "stream usage signal ids do not match containing event",
                    ));
                }
                if signal.backend != self.adapter.backend() {
                    return Err(BridgeError::new(
                        "event_backend_mismatch",
                        "stream usage backend does not match bridge adapter",
                    ));
                }
            }
            BridgeEventPayload::PolicyHint { hint } => {
                if hint.session_id != event.session_id
                    || hint
                        .run_id
                        .as_ref()
                        .is_some_and(|run_id| run_id != &event.run_id)
                {
                    return Err(BridgeError::new(
                        "event_policy_hint_mismatch",
                        "stream policy hint ids do not match containing event",
                    ));
                }
            }
            BridgeEventPayload::Status { status } => {
                if status.backend != self.adapter.backend() {
                    return Err(BridgeError::new(
                        "event_backend_mismatch",
                        "stream status backend does not match bridge adapter",
                    ));
                }
            }
            BridgeEventPayload::Artifact { artifact } => {
                if artifact.run_id != event.run_id || artifact.session_id != event.session_id {
                    return Err(BridgeError::new(
                        "event_artifact_mismatch",
                        "stream artifact ids do not match containing event",
                    ));
                }
            }
            BridgeEventPayload::UsageSummary { .. } => {
                // A usage summary is a device-wide, host-synthesized response to a
                // client query — never an event an adapter streams from a run. Seeing
                // one here means a backend emitted a frame it must not.
                return Err(BridgeError::new(
                    "event_unexpected_usage_summary",
                    "a backend stream must not emit a device-wide usage summary",
                ));
            }
            BridgeEventPayload::CoachingHints { .. } => {
                // Likewise device-wide and host-synthesized — never adapter-streamed.
                return Err(BridgeError::new(
                    "event_unexpected_coaching_hints",
                    "a backend stream must not emit device-wide coaching hints",
                ));
            }
            BridgeEventPayload::AgentCatalog { .. } => {
                // Device-wide, host-synthesized discovery result — never streamed.
                return Err(BridgeError::new(
                    "event_unexpected_agent_catalog",
                    "a backend stream must not emit a device-wide agent catalog",
                ));
            }
        }

        Ok(())
    }

    pub fn run(&self, run_id: &str) -> Result<&ManagedRun, BridgeError> {
        self.runs
            .get(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))
    }

    /// Discover the user's own agent definitions (packet 09 §3f-bis), read-only, from
    /// within the workspace allowlist. With `Some(root)` it scans that one root (which
    /// **must** be allowlisted — discovery never reads outside the allowlist); with
    /// `None` it scans **every** allowlisted root. Best-effort per root (a missing
    /// `.claude/agents`/`.copilot/agents` folder is simply empty).
    ///
    /// When (and only when) user-global discovery is **opted in** via
    /// [`Self::with_global_home`], it also scans the **user-global** folders
    /// (`~/.claude/agents`, `~/.copilot/agents`) once — the user's own home config, read
    /// outside the workspace allowlist by explicit configuration (off by default). A
    /// **project** definition shadows a **global** one within a backend; definitions dedupe
    /// by **name** into one entry runnable on the set of backends that define it (see
    /// [`merge_agents`]).
    ///
    /// Results are filtered before merging to the backends this runtime can **actually
    /// launch** — its single adapter's backend, and only when that backend is allowlisted
    /// (both gates `start` enforces). A backend is dropped from an entry if it is not
    /// launchable, and an entry is dropped only if no launchable backend remains — so the
    /// catalog never advertises an agent that could not be run.
    pub fn discover_agents(
        &self,
        workspace_root: Option<&str>,
    ) -> Result<Vec<AgentDefinition>, BridgeError> {
        let mut raws = match workspace_root {
            Some(root) => {
                self.ensure_workspace_allowed(root)?;
                discover_raw_in_root(root)
            }
            None => {
                let mut all = Vec::new();
                for root in self.workspace_allowlist.roots() {
                    all.extend(discover_raw_in_root(root));
                }
                all
            }
        };
        // The global scope is not gated by the workspace allowlist (it is the user's own
        // home), and is read once independent of how many workspaces were scanned.
        if let Some(home) = &self.global_home {
            raws.extend(discover_raw_global_in(home));
        }
        // Filter per-backend to what this runtime can ACTUALLY launch, so the catalog
        // never advertises a binding that `start` would then reject. `start` requires the
        // session backend to equal this runtime's single adapter backend AND that backend
        // to be allowlisted, so the launchable set is exactly `{ adapter.backend() }` when
        // it is allowlisted, else empty. Filtering on the allowlist alone is not enough: a
        // Claude-adapter runtime whose allowlist also contains Copilot would otherwise
        // advertise `copilot.local` bindings it would reject at launch with
        // `backend_mismatch`. (A future multi-adapter host would widen `launchable`.) A
        // name surviving on only its launchable backends becomes an entry listing just
        // those; a name with no launchable backend produces no entry at all.
        let launchable = self.adapter.backend();
        raws.retain(|raw| raw.backend == launchable && self.backend_allowlist.allows(&raw.backend));
        Ok(merge_agents(raws))
    }

    /// A device-wide "your spend" summary over every run this runtime holds. Usage
    /// signals are read back out of each run's event log (where `stream_events`
    /// already records them), grouped per `(backend, fidelity)`, and rolled up by the
    /// pure [`UsageSummary::from_signals`] aggregator — so the live runtime and a
    /// future persistent store share one summarization path (ADR-0092 D2).
    pub fn usage_summary(&self) -> UsageSummary {
        let mut signals: Vec<UsageSignal> = Vec::new();
        let mut sessions: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for managed in self.runs.values() {
            sessions.insert(managed.session.id.as_str());
            for event in &managed.event_log {
                if let BridgeEventPayload::Usage { signal } = &event.payload {
                    signals.push(signal.clone());
                }
            }
        }
        UsageSummary::from_signals(&signals, sessions.len() as u64)
    }

    /// Run the rules-based session coach (ADR-0092 D4) over **every** session this
    /// runtime holds and return all advisory hints, stamped `now`. This is the
    /// cross-session coaching surface (packet 09 §3e) — the structured, wire-borne
    /// counterpart to the per-session inline diagnostics. Each session's snapshot is
    /// built from its runs' transcripts (non-partial message count) and recorded
    /// usage; `elapsed_minutes` is `None` (the crate stays clock-free and idle
    /// wall-time is a weak staleness signal — the token/message thresholds carry the
    /// `stale_session` rule). Pure given `now`; `coach` itself is deterministic.
    pub fn coaching_hints(&self, now: &str) -> Vec<PolicyHint> {
        struct LatestRun {
            /// `(started_at, run_id)` of the chosen anchor run, kept as the max so the
            /// selection is deterministic regardless of `HashMap` iteration order.
            key: (Option<String>, String),
            /// Settled (non-partial) message count of **that** run's transcript.
            message_count: usize,
        }
        struct SessionAggregate {
            backend: AgentBackend,
            latest: Option<LatestRun>,
            usage: Vec<UsageSignal>,
        }

        let mut sessions: std::collections::BTreeMap<String, SessionAggregate> =
            std::collections::BTreeMap::new();
        for managed in self.runs.values() {
            let aggregate = sessions
                .entry(managed.session.id.clone())
                .or_insert_with(|| SessionAggregate {
                    backend: managed.session.backend.clone(),
                    latest: None,
                    usage: Vec::new(),
                });
            // Usage is per-turn (each run emits its own signal), so it sums across the
            // session's runs.
            for event in &managed.event_log {
                if let BridgeEventPayload::Usage { signal } = &event.payload {
                    aggregate.usage.push(signal.clone());
                }
            }
            // Anchor a hint to the session's **latest** run, chosen deterministically:
            // the run with the greatest `(started_at, run_id)`. This relies on the
            // system-wide invariant that timestamps are normalized RFC3339 **UTC**
            // strings (`...Z`, fixed `now_rfc3339` format), which then sort
            // lexicographically in chronological order — the same invariant
            // `store::prune` and `replay_events` already depend on. The `run_id` breaks
            // ties, so the order is total and the pick is stable for a given runtime
            // state. (`self.runs` is a `HashMap` whose order is unspecified, so a "last
            // one wins" pick would instead attach persisted hints to different runs
            // between identical calls.) The message count is read from **only** that
            // latest run: `reply()` carries the prior transcript into each follow-up
            // run, so the latest run already holds the full cumulative history — summing
            // every run's transcript would double-count the carried messages and trip
            // `stale_session` too early on resume-based backends.
            let candidate = (
                managed.record.run.started_at.clone(),
                managed.record.run.id.clone(),
            );
            let replace = match &aggregate.latest {
                None => true,
                Some(current) => candidate > current.key,
            };
            if replace {
                let message_count = managed
                    .transcript
                    .iter()
                    .filter(|message| message.is_partial != Some(true))
                    .count();
                aggregate.latest = Some(LatestRun {
                    key: candidate,
                    message_count,
                });
            }
        }

        let mut hints = Vec::new();
        for (session_id, aggregate) in &sessions {
            let snapshot = CoachingSnapshot {
                session_id,
                run_id: aggregate
                    .latest
                    .as_ref()
                    .map(|latest| latest.key.1.as_str()),
                backend: aggregate.backend.clone(),
                message_count: aggregate
                    .latest
                    .as_ref()
                    .map_or(0, |latest| latest.message_count),
                elapsed_minutes: None,
                usage: &aggregate.usage,
                now,
            };
            hints.extend(coach(&snapshot));
        }
        hints
    }

    pub fn replay_events(
        &self,
        request: &ReconnectRequest,
    ) -> Result<Vec<BridgeEvent>, BridgeError> {
        let mut events = if let Some(run_id) = &request.run_id {
            let managed = self.run(run_id)?;
            if managed.session.id != request.session_id {
                return Err(BridgeError::new(
                    "session_mismatch",
                    "reconnect run does not belong to requested session",
                ));
            }
            managed.event_log.clone()
        } else {
            let mut events = self
                .runs
                .values()
                .filter(|managed| managed.session.id == request.session_id)
                .flat_map(|managed| managed.event_log.clone())
                .collect::<Vec<_>>();
            events.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then(left.sequence.cmp(&right.sequence))
                    .then(left.id.cmp(&right.id))
            });
            events
        };

        if let Some(last_event_id) = &request.last_event_id {
            let position = events
                .iter()
                .position(|event| &event.id == last_event_id)
                .ok_or_else(|| {
                    BridgeError::new(
                        "event_not_found",
                        "last event id was not found in reconnect log",
                    )
                })?;
            events.drain(..=position);
        }

        Ok(events)
    }

    fn run_mut(&mut self, run_id: &str) -> Result<&mut ManagedRun, BridgeError> {
        self.runs
            .get_mut(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))
    }

    fn transition_run(
        &mut self,
        run_id: &str,
        next: DispatchRunState,
        created_at: impl Into<String>,
    ) -> Result<(), BridgeError> {
        let managed = self.run_mut(run_id)?;
        if managed.record.run.state != next {
            let event = managed.record.transition_to(next, created_at)?;
            Self::push_control_bridge_event(managed, event);
        }
        Ok(())
    }

    fn control_events_to_bridge_events(events: Vec<DispatchControlEvent>) -> Vec<BridgeEvent> {
        events
            .into_iter()
            .enumerate()
            .map(|(sequence, event)| Self::control_bridge_event(sequence as u64, event))
            .collect()
    }

    fn push_control_bridge_event(managed: &mut ManagedRun, event: DispatchControlEvent) {
        let sequence = managed.event_log.len() as u64;
        Self::push_bridge_event(managed, Self::control_bridge_event(sequence, event));
    }

    fn push_bridge_event(managed: &mut ManagedRun, mut event: BridgeEvent) {
        event.sequence = managed.event_log.len() as u64;
        managed.event_log.push(event);
    }

    fn control_bridge_event(sequence: u64, event: DispatchControlEvent) -> BridgeEvent {
        BridgeEvent::control(
            event.id.clone(),
            event.session_id.clone(),
            event.run_id.clone(),
            sequence,
            event.created_at.clone(),
            event,
        )
    }

    fn ensure_backend_allowed(&self) -> Result<(), BridgeError> {
        if self.backend_allowlist.allows(&self.adapter.backend()) {
            Ok(())
        } else {
            Err(BridgeError::new(
                "backend_not_allowed",
                "backend is not on the configured bridge allowlist",
            ))
        }
    }

    fn ensure_workspace_allowed(&self, workspace_root: &str) -> Result<(), BridgeError> {
        if self.workspace_allowlist.allows(workspace_root) {
            Ok(())
        } else {
            Err(BridgeError::new(
                "workspace_not_allowed",
                "workspace is outside the configured bridge allowlist",
            ))
        }
    }

    fn ensure_request_workspace_matches(
        &self,
        request: &StartRunRequest,
    ) -> Result<(), BridgeError> {
        let request_workspace = Self::canonical_workspace(&request.workspace_root)?;
        let session_workspace = Self::canonical_workspace(&request.session.workspace_root)?;
        if request_workspace == session_workspace {
            Ok(())
        } else {
            Err(BridgeError::new(
                "workspace_mismatch",
                "request workspace root does not match session workspace root",
            ))
        }
    }

    fn canonical_workspace(workspace_root: &str) -> Result<PathBuf, BridgeError> {
        let path = Path::new(workspace_root);
        if !path.is_absolute() {
            return Err(BridgeError::new(
                "workspace_not_allowed",
                "workspace root must be an absolute path",
            ));
        }
        path.canonicalize().map_err(|_| {
            BridgeError::new(
                "workspace_not_allowed",
                "workspace root could not be resolved on disk",
            )
        })
    }

    fn ensure_run_id_available(&self, run_id: &str) -> Result<(), BridgeError> {
        if self.runs.contains_key(run_id) {
            Err(BridgeError::new(
                "duplicate_run_id",
                format!("run {run_id} is already managed by this bridge runtime"),
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{AgentBackend, CapabilityFlags};
    use crate::session::DispatchMessageRole;
    use crate::wire::BridgeStatusEvent;
    use std::cell::RefCell;
    use std::fs;

    struct FakeAdapter {
        capabilities: CapabilityFlags,
        starts: RefCell<u64>,
        start_requests: RefCell<Vec<StartRunRequest>>,
        stream_events: RefCell<Option<Vec<BridgeEvent>>>,
        replies: RefCell<Vec<String>>,
        stops: RefCell<Vec<String>>,
    }

    impl FakeAdapter {
        fn new(capabilities: CapabilityFlags) -> Self {
            Self {
                capabilities,
                starts: RefCell::new(0),
                start_requests: RefCell::new(Vec::new()),
                stream_events: RefCell::new(None),
                replies: RefCell::new(Vec::new()),
                stops: RefCell::new(Vec::new()),
            }
        }

        fn with_stream_events(self, events: Vec<BridgeEvent>) -> Self {
            *self.stream_events.borrow_mut() = Some(events);
            self
        }
    }

    impl AgentBackendAdapter for FakeAdapter {
        fn backend(&self) -> AgentBackend {
            AgentBackend::ClaudeLocal
        }

        fn capabilities(&self) -> CapabilityFlags {
            self.capabilities.clone()
        }

        fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
            let mut starts = self.starts.borrow_mut();
            *starts += 1;
            self.start_requests.borrow_mut().push(request.clone());
            Ok(RunHandle {
                run_id: request
                    .requested_run_id
                    .unwrap_or_else(|| format!("run-{starts}")),
                process_id: Some(4321),
            })
        }

        fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
            if let Some(events) = self.stream_events.borrow().clone() {
                return Ok(events);
            }

            Ok(vec![
                BridgeEvent {
                    id: "event-0".to_string(),
                    session_id: "session-1".to_string(),
                    run_id: run_id.to_string(),
                    sequence: 0,
                    created_at: "2026-06-07T12:00:30Z".to_string(),
                    payload: BridgeEventPayload::Message {
                        message: DispatchMessage {
                            id: "message-1".to_string(),
                            session_id: "session-1".to_string(),
                            run_id: run_id.to_string(),
                            role: DispatchMessageRole::Agent,
                            body: "need input".to_string(),
                            created_at: "2026-06-07T12:00:30Z".to_string(),
                            is_partial: Some(false),
                        },
                    },
                },
                BridgeEvent::status(
                    "event-1",
                    "session-1",
                    run_id,
                    1,
                    "2026-06-07T12:01:00Z",
                    BridgeStatusEvent {
                        state: DispatchRunState::NeedsInput,
                        backend: AgentBackend::ClaudeLocal,
                        repo_hint: Some("HoneyDrunk.HoneyHub".to_string()),
                        link: None,
                    },
                ),
            ])
        }

        fn reply(&self, run_id: &str, _text: &str) -> Result<(), BridgeError> {
            self.replies.borrow_mut().push(run_id.to_string());
            Ok(())
        }

        fn stop(&self, run_id: &str) -> Result<(), BridgeError> {
            self.stops.borrow_mut().push(run_id.to_string());
            Ok(())
        }

        fn resume(&self, _session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
            Ok(RunHandle {
                run_id: "resumed-run".to_string(),
                process_id: None,
            })
        }
    }

    fn workspace_paths() -> (String, String) {
        let root = std::env::temp_dir().join(format!("honeyhub-core-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("workspace is created");
        (
            root.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
        )
    }

    fn session(workspace_root: &str) -> DispatchSession {
        DispatchSession {
            id: "session-1".to_string(),
            backend: AgentBackend::ClaudeLocal,
            title: "Bridge core".to_string(),
            workspace_root: workspace_root.to_string(),
            created_at: "2026-06-07T12:00:00Z".to_string(),
            updated_at: "2026-06-07T12:00:00Z".to_string(),
            current_run_id: None,
        }
    }

    fn request(workspace_root: &str) -> StartRunRequest {
        StartRunRequest {
            session: session(workspace_root),
            workspace_root: workspace_root.to_string(),
            task: "ship bridge core".to_string(),
            requested_run_id: None,
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: Some(vec![
                "claude".to_string(),
                "--api-key".to_string(),
                "secret-value".to_string(),
            ]),
        }
    }

    #[test]
    fn lifecycle_start_stream_reply_stop_records_transitions() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );

        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
        assert_eq!(
            runtime
                .run(&handle.run_id)
                .expect("run exists")
                .process
                .process_id,
            Some(4321)
        );
        runtime
            .stream_events(&handle.run_id)
            .expect("stream applies");
        assert_eq!(
            runtime
                .run(&handle.run_id)
                .expect("run exists")
                .record
                .run
                .state,
            DispatchRunState::NeedsInput
        );

        let outcome = runtime
            .reply(&handle.run_id, "continue", "2026-06-07T12:02:00Z")
            .expect("reply accepted");
        runtime
            .stop(&handle.run_id, "2026-06-07T12:03:00Z")
            .expect("stop accepted");

        assert_eq!(outcome, ReplyOutcome::LiveReplyAccepted);
        let managed = runtime.run(&handle.run_id).expect("run exists");
        assert_eq!(managed.record.run.state, DispatchRunState::Stopping);
        assert!(managed
            .record
            .control_events
            .iter()
            .any(|event| event.kind == DispatchControlEventKind::Launch));
        assert!(managed
            .record
            .control_events
            .iter()
            .any(|event| event.kind == DispatchControlEventKind::Reply));
        assert!(managed
            .record
            .control_events
            .iter()
            .any(|event| event.kind == DispatchControlEventKind::Stop));
    }

    #[test]
    fn refuses_workspace_outside_allowlist() {
        let (_allowlist_root, workspace_root) = workspace_paths();
        let (other_root, _other_workspace) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![other_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );

        let error = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect_err("outside workspace is denied");

        assert_eq!(error.code, "workspace_not_allowed");
    }

    #[test]
    fn refuses_backend_outside_allowlist() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::CodexLocal]),
        );

        let error = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect_err("disallowed backend is denied");

        assert_eq!(error.code, "backend_not_allowed");
        assert_eq!(*runtime.adapter.starts.borrow(), 0);
    }

    #[test]
    fn routes_reply_to_follow_up_when_backend_is_not_interactive() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let mut capabilities = CapabilityFlags::claude_local();
        capabilities.interactive_reply = false;
        let adapter = FakeAdapter::new(capabilities);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
        runtime
            .stream_events(&handle.run_id)
            .expect("stream applies");

        let outcome = runtime
            .reply(&handle.run_id, "continue", "2026-06-07T12:02:00Z")
            .expect("reply follows up");

        assert_eq!(
            runtime
                .run(&handle.run_id)
                .expect("run exists")
                .record
                .run
                .state,
            DispatchRunState::Completed
        );
        let start_requests = runtime.adapter.start_requests.borrow();
        assert_eq!(start_requests.len(), 2);
        assert_eq!(
            start_requests[1].follow_up_to_run_id,
            Some(handle.run_id.clone())
        );
        assert_eq!(start_requests[1].transcript.len(), 1);
        assert!(matches!(outcome, ReplyOutcome::FollowUpRunStarted(_)));
    }

    #[test]
    fn process_exit_validates_run_id_and_preserves_stop_as_cancelled() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");

        let mismatch = runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: "other-run".to_string(),
                    code: Some(0),
                    signal: None,
                    success: true,
                    exited_at: "2026-06-07T12:03:00Z".to_string(),
                },
            )
            .expect_err("mismatched exit is rejected");
        assert_eq!(mismatch.code, "process_exit_run_mismatch");

        runtime
            .stop(&handle.run_id, "2026-06-07T12:04:00Z")
            .expect("stop accepted");
        runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: handle.run_id.clone(),
                    code: Some(0),
                    signal: None,
                    success: true,
                    exited_at: "2026-06-07T12:05:00Z".to_string(),
                },
            )
            .expect("exit applies");

        assert_eq!(
            runtime
                .run(&handle.run_id)
                .expect("run exists")
                .record
                .run
                .state,
            DispatchRunState::Cancelled
        );
    }

    #[test]
    fn rejects_duplicate_run_id_without_overwriting_existing_record() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let mut first = request(&workspace_root);
        first.requested_run_id = Some("run-fixed".to_string());
        runtime
            .start(first, "2026-06-07T12:00:00Z")
            .expect("first run starts");

        let mut second = request(&workspace_root);
        second.requested_run_id = Some("run-fixed".to_string());
        let error = runtime
            .start(second, "2026-06-07T12:01:00Z")
            .expect_err("duplicate run is rejected");

        assert_eq!(error.code, "duplicate_run_id");
        assert!(runtime.run("run-fixed").is_ok());
    }

    #[test]
    fn stop_timeout_records_terminal_escalation() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");

        runtime
            .stop(&handle.run_id, "2026-06-07T12:01:00Z")
            .expect("stop starts");
        runtime
            .handle_stop_timeout(&handle.run_id, "2026-06-07T12:01:05Z")
            .expect("timeout escalates");

        let managed = runtime.run(&handle.run_id).expect("run exists");
        assert_eq!(managed.record.run.state, DispatchRunState::Failed);
        assert_eq!(
            managed.record.run.failure_reason,
            Some("graceful stop timed out".to_string())
        );
        assert!(managed
            .record
            .control_events
            .iter()
            .any(|event| event.kind == DispatchControlEventKind::Timeout));
    }

    #[test]
    fn reconnect_replays_events_after_last_seen_event() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
        runtime
            .stream_events(&handle.run_id)
            .expect("stream applies");

        let all_events = runtime
            .replay_events(&ReconnectRequest {
                session_id: "session-1".to_string(),
                run_id: Some(handle.run_id.clone()),
                last_event_id: None,
            })
            .expect("events replay");
        assert!(all_events.iter().any(|event| event.id == "event-0"));
        assert!(all_events.iter().any(|event| event.id == "event-1"));
        assert!(all_events
            .iter()
            .enumerate()
            .all(|(sequence, event)| event.sequence == sequence as u64));

        let missed_events = runtime
            .replay_events(&ReconnectRequest {
                session_id: "session-1".to_string(),
                run_id: Some(handle.run_id.clone()),
                last_event_id: Some("event-0".to_string()),
            })
            .expect("missed events replay");

        assert!(missed_events.iter().all(|event| event.id != "event-0"));
        assert!(missed_events.iter().any(|event| event.id == "event-1"));
    }

    #[test]
    fn stream_collects_artifacts_into_managed_run() {
        use crate::artifact::{ArtifactKind, DispatchArtifact};
        let (allowlist_root, workspace_root) = workspace_paths();
        let artifact_event = BridgeEvent::artifact(
            "event-artifact",
            "session-1",
            "run-fixed",
            0,
            "2026-06-07T12:01:00Z",
            DispatchArtifact {
                id: "artifact-1".to_string(),
                session_id: "session-1".to_string(),
                run_id: "run-fixed".to_string(),
                kind: ArtifactKind::PullRequest,
                label: "Open PR".to_string(),
                href: Some("https://example.test/pr/1".to_string()),
                repo_relative_path: None,
                created_at: "2026-06-07T12:01:00Z".to_string(),
            },
        );
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local())
            .with_stream_events(vec![artifact_event]);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let mut start = request(&workspace_root);
        start.requested_run_id = Some("run-fixed".to_string());
        let handle = runtime
            .start(start, "2026-06-07T12:00:00Z")
            .expect("run starts");

        runtime
            .stream_events(&handle.run_id)
            .expect("artifact stream applies");

        let managed = runtime.run(&handle.run_id).expect("run exists");
        assert_eq!(managed.artifacts.len(), 1);
        assert_eq!(managed.artifacts[0].kind, ArtifactKind::PullRequest);
    }

    #[test]
    fn rejects_session_workspace_mismatch_before_launch() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let (_other_root, other_workspace) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let mut mismatched = request(&workspace_root);
        mismatched.session.workspace_root = other_workspace;

        let error = runtime
            .start(mismatched, "2026-06-07T12:00:00Z")
            .expect_err("mismatched session workspace is rejected");

        assert_eq!(error.code, "workspace_mismatch");
        assert_eq!(*runtime.adapter.starts.borrow(), 0);
    }

    #[test]
    fn rejects_inconsistent_stream_payloads_without_mutating_run() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let message = DispatchMessage {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "other-run".to_string(),
            role: DispatchMessageRole::Agent,
            body: "bad ids".to_string(),
            created_at: "2026-06-07T12:01:00Z".to_string(),
            is_partial: Some(false),
        };
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local()).with_stream_events(vec![
            BridgeEvent::message(
                "event-1",
                "session-1",
                "run-fixed",
                1,
                "2026-06-07T12:01:00Z",
                message,
            ),
        ]);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let mut start = request(&workspace_root);
        start.requested_run_id = Some("run-fixed".to_string());
        let handle = runtime
            .start(start, "2026-06-07T12:00:00Z")
            .expect("run starts");

        let error = runtime
            .stream_events(&handle.run_id)
            .expect_err("mismatched payload ids are rejected");

        assert_eq!(error.code, "event_message_mismatch");
        assert!(runtime
            .run(&handle.run_id)
            .expect("run exists")
            .transcript
            .is_empty());
    }

    #[test]
    fn terminal_runs_reject_replies_and_ignore_late_exit_transitions() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");

        runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: handle.run_id.clone(),
                    code: Some(0),
                    signal: None,
                    success: true,
                    exited_at: "2026-06-07T12:01:00Z".to_string(),
                },
            )
            .expect("exit completes run");
        runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: handle.run_id.clone(),
                    code: Some(0),
                    signal: None,
                    success: true,
                    exited_at: "2026-06-07T12:02:00Z".to_string(),
                },
            )
            .expect("late exit is recorded without a transition");
        let error = runtime
            .reply(&handle.run_id, "continue", "2026-06-07T12:03:00Z")
            .expect_err("terminal run cannot receive replies");

        let managed = runtime.run(&handle.run_id).expect("run exists");
        assert_eq!(managed.record.run.state, DispatchRunState::Completed);
        assert_eq!(error.code, "terminal_run_reply");
        assert!(runtime.adapter.replies.borrow().is_empty());
    }

    #[test]
    fn terminal_resume_based_run_replies_via_follow_up() {
        // A resume-based backend (codex.local / copilot.local: interactive_reply
        // false + resume_session) ends each turn as a completed `exec` process, so a
        // reply to a *terminal* run must start a follow-up run that resumes the
        // session — not be rejected as `terminal_run_reply` (which only applies to
        // interactive backends that cannot write into an exited process).
        let (allowlist_root, workspace_root) = workspace_paths();
        let mut capabilities = CapabilityFlags::claude_local();
        capabilities.interactive_reply = false; // resume_session stays true
        let adapter = FakeAdapter::new(capabilities);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
        runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: handle.run_id.clone(),
                    code: Some(0),
                    signal: None,
                    success: true,
                    exited_at: "2026-06-07T12:01:00Z".to_string(),
                },
            )
            .expect("exit completes the turn");
        assert!(runtime
            .run(&handle.run_id)
            .expect("run exists")
            .record
            .run
            .state
            .is_terminal());

        let outcome = runtime
            .reply(&handle.run_id, "continue", "2026-06-07T12:02:00Z")
            .expect("terminal resume-based run replies via a follow-up run");
        assert!(matches!(outcome, ReplyOutcome::FollowUpRunStarted(_)));
        let start_requests = runtime.adapter.start_requests.borrow();
        assert_eq!(start_requests.len(), 2);
        assert_eq!(
            start_requests[1].follow_up_to_run_id,
            Some(handle.run_id.clone())
        );
    }

    #[test]
    fn failed_terminal_run_rejects_reply_even_on_resume_based_backend() {
        // The resume-based follow-up path is only valid for a cleanly `Completed`
        // run; a run that ended in a non-success terminal state (here `Failed`) is not
        // a sound base to resume from, so the reply is still rejected.
        let (allowlist_root, workspace_root) = workspace_paths();
        let mut capabilities = CapabilityFlags::claude_local();
        capabilities.interactive_reply = false; // resume_session stays true
        let adapter = FakeAdapter::new(capabilities);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
        runtime
            .handle_process_exit(
                &handle.run_id,
                ProcessExitStatus {
                    run_id: handle.run_id.clone(),
                    code: Some(1),
                    signal: None,
                    success: false,
                    exited_at: "2026-06-07T12:01:00Z".to_string(),
                },
            )
            .expect("non-zero exit fails the run");
        assert_eq!(
            runtime
                .run(&handle.run_id)
                .expect("run exists")
                .record
                .run
                .state,
            DispatchRunState::Failed
        );

        let error = runtime
            .reply(&handle.run_id, "continue", "2026-06-07T12:02:00Z")
            .expect_err("a failed terminal run is not a valid reply target");
        assert_eq!(error.code, "terminal_run_reply");
        // No follow-up run was started.
        assert_eq!(runtime.adapter.start_requests.borrow().len(), 1);
    }

    #[test]
    fn usage_summary_rolls_up_streamed_usage_across_runs() {
        // A streamed usage signal is recorded into the run's event log, so the
        // device-wide summary reads it back out and rolls it up — exact USD here
        // lands in the grounded headline.
        let (allowlist_root, workspace_root) = workspace_paths();
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-fixed".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity: crate::session::UsageFidelity::Exact,
            model_label: None,
            input_tokens: Some(30),
            output_tokens: Some(20),
            total_tokens: Some(50),
            total_usd: Some(0.25),
            premium_requests: None,
            duration_ms: Some(1200),
            confidence: None,
            recorded_at: "2026-06-07T12:01:00Z".to_string(),
        };
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local()).with_stream_events(vec![
            BridgeEvent::usage(
                "event-usage",
                "session-1",
                "run-fixed",
                1,
                "2026-06-07T12:01:00Z",
                usage,
            ),
        ]);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );

        // No runs yet → an empty, honest summary (not an error).
        let empty = runtime.usage_summary();
        assert!(empty.rollups.is_empty());
        assert_eq!(empty.session_count, 0);
        assert_eq!(empty.grounded_total_usd, None);

        let mut start = request(&workspace_root);
        start.requested_run_id = Some("run-fixed".to_string());
        let handle = runtime
            .start(start, "2026-06-07T12:00:00Z")
            .expect("run starts");
        runtime
            .stream_events(&handle.run_id)
            .expect("usage event applies");

        let summary = runtime.usage_summary();
        assert_eq!(summary.session_count, 1);
        assert_eq!(summary.total_turns, 1);
        assert_eq!(summary.rollups.len(), 1);
        assert_eq!(summary.rollups[0].backend, AgentBackend::ClaudeLocal);
        assert_eq!(summary.rollups[0].total_tokens, 50);
        let grounded = summary.grounded_total_usd.expect("grounded usd present");
        assert!((grounded - 0.25).abs() < 1e-9, "grounded was {grounded}");
    }

    #[test]
    fn coaching_hints_flag_a_stale_session_and_are_empty_with_no_runs() {
        let (allowlist_root, workspace_root) = workspace_paths();
        // A large-context (high-token) usage signal trips the stale_session rule.
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-fixed".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity: crate::session::UsageFidelity::Exact,
            model_label: None,
            input_tokens: Some(200_000),
            output_tokens: Some(0),
            total_tokens: Some(200_000),
            total_usd: Some(0.5),
            premium_requests: None,
            duration_ms: None,
            confidence: None,
            recorded_at: "2026-06-08T12:00:00Z".to_string(),
        };
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local()).with_stream_events(vec![
            BridgeEvent::usage(
                "event-usage",
                "session-1",
                "run-fixed",
                1,
                "2026-06-08T12:00:00Z",
                usage,
            ),
        ]);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );

        // No runs yet → no advisories (not an error).
        assert!(runtime.coaching_hints("2026-06-08T12:00:00Z").is_empty());

        let mut start = request(&workspace_root);
        start.requested_run_id = Some("run-fixed".to_string());
        let handle = runtime
            .start(start, "2026-06-08T12:00:00Z")
            .expect("run starts");
        runtime
            .stream_events(&handle.run_id)
            .expect("usage event applies");

        let hints = runtime.coaching_hints("2026-06-08T12:05:00Z");
        assert!(
            hints.iter().any(|hint| hint.code == "stale_session"),
            "expected a stale_session advisory, got {:?}",
            hints.iter().map(|h| &h.code).collect::<Vec<_>>()
        );
        // Advisory-only posture: never a Block severity.
        assert!(hints
            .iter()
            .all(|hint| hint.severity != crate::session::PolicyHintSeverity::Block));
        // The hint is stamped with the supplied `now`.
        let stale = hints.iter().find(|h| h.code == "stale_session").unwrap();
        assert_eq!(stale.created_at, "2026-06-08T12:05:00Z");
        assert_eq!(stale.session_id, "session-1");
    }

    #[test]
    fn coaching_hints_anchor_the_latest_run_deterministically() {
        // A session with two runs: the hint must anchor to the latest run (greatest
        // started_at) regardless of HashMap order, and be identical across calls.
        let (allowlist_root, workspace_root) = workspace_paths();
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-late".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity: crate::session::UsageFidelity::Exact,
            model_label: None,
            input_tokens: Some(200_000),
            output_tokens: Some(0),
            total_tokens: Some(200_000),
            total_usd: Some(0.5),
            premium_requests: None,
            duration_ms: None,
            confidence: None,
            recorded_at: "2026-06-08T12:05:00Z".to_string(),
        };
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local()).with_stream_events(vec![
            BridgeEvent::usage(
                "event-usage",
                "session-1",
                "run-late",
                1,
                "2026-06-08T12:05:00Z",
                usage,
            ),
        ]);
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );

        let mut early = request(&workspace_root);
        early.requested_run_id = Some("run-early".to_string());
        runtime
            .start(early, "2026-06-08T12:00:00Z")
            .expect("early run starts");
        let mut late = request(&workspace_root);
        late.requested_run_id = Some("run-late".to_string());
        runtime
            .start(late, "2026-06-08T12:05:00Z")
            .expect("late run starts");
        runtime
            .stream_events("run-late")
            .expect("usage applies to the late run");

        let first = runtime.coaching_hints("2026-06-08T12:10:00Z");
        let second = runtime.coaching_hints("2026-06-08T12:10:00Z");
        assert_eq!(first, second, "coaching hints must be deterministic");
        let stale = first
            .iter()
            .find(|hint| hint.code == "stale_session")
            .expect("a stale_session advisory");
        // The later-started run is the anchor, not whichever HashMap yields last.
        assert_eq!(stale.run_id.as_deref(), Some("run-late"));
    }

    #[test]
    fn coaching_message_count_uses_latest_run_not_the_carried_forward_sum() {
        // A resume-based reply carries the prior transcript into each follow-up run,
        // so the latest run already holds the cumulative history. Counting every run's
        // transcript would double-count and trip stale_session too early. Two runs of
        // 20 settled messages each: summed (40) would be stale; latest-only (20) is not.
        let (allowlist_root, workspace_root) = workspace_paths();
        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        let mut runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![allowlist_root]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        );
        let messages = |run: &str| -> Vec<DispatchMessage> {
            (0..20)
                .map(|index| DispatchMessage {
                    id: format!("{run}-m{index}"),
                    session_id: "session-1".to_string(),
                    run_id: run.to_string(),
                    role: DispatchMessageRole::Agent,
                    body: "x".to_string(),
                    created_at: "2026-06-08T12:00:00Z".to_string(),
                    is_partial: Some(false),
                })
                .collect()
        };

        let mut early = request(&workspace_root);
        early.requested_run_id = Some("run-early".to_string());
        early.transcript = messages("run-early");
        runtime
            .start(early, "2026-06-08T12:00:00Z")
            .expect("early run starts");
        let mut late = request(&workspace_root);
        late.requested_run_id = Some("run-late".to_string());
        late.transcript = messages("run-late");
        runtime
            .start(late, "2026-06-08T12:05:00Z")
            .expect("late run starts");

        let hints = runtime.coaching_hints("2026-06-08T12:10:00Z");
        assert!(
            !hints.iter().any(|hint| hint.code == "stale_session"),
            "message_count must use the latest run only, not the carried-forward sum"
        );
    }

    #[test]
    fn discover_agents_scans_allowlisted_roots_and_refuses_others() {
        let (_, workspace_root) = workspace_paths();
        // A Claude subagent inside the allowlisted workspace.
        let agent_dir = std::path::Path::new(&workspace_root).join(".claude/agents");
        fs::create_dir_all(&agent_dir).expect("agent dir");
        fs::write(
            agent_dir.join("reviewer.md"),
            "---\nname: Reviewer\ndescription: Reviews diffs\n---\nbody\n",
        )
        .expect("write agent");
        // A Copilot agent in the same workspace; the backend allowlist below does NOT
        // include copilot.local, so discovery must not surface it as runnable.
        let copilot_dir = std::path::Path::new(&workspace_root).join(".copilot/agents");
        fs::create_dir_all(&copilot_dir).expect("copilot agents dir");
        fs::write(
            copilot_dir.join("release.md"),
            "---\nname: Release Agent\n---\nbody\n",
        )
        .expect("write copilot agent");

        let adapter = FakeAdapter::new(CapabilityFlags::claude_local());
        // Allowlist the workspace root itself, so both the scoped and the scan-all
        // paths look in the folder that holds the agent. Only claude.local is in the
        // backend allowlist. Pin the global home to an empty temp dir so the developer's
        // real `~/.claude/agents` can never leak into the assertions.
        let empty_home = std::env::temp_dir().join(format!("honeyhub-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&empty_home).expect("empty home");
        let runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(vec![workspace_root.clone()]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        )
        .with_global_home(Some(empty_home.clone()));

        // Scanning the allowlisted root finds the Claude agent — and filters out the
        // Copilot one, whose backend is not in the allowlist (can't be launched).
        let scoped = runtime
            .discover_agents(Some(&workspace_root))
            .expect("allowlisted root scans");
        assert_eq!(
            scoped.len(),
            1,
            "copilot agent filtered by backend allowlist"
        );
        assert_eq!(scoped[0].name, "Reviewer");
        assert_eq!(scoped[0].backends.len(), 1);
        assert_eq!(scoped[0].backends[0].backend, AgentBackend::ClaudeLocal);

        // Scanning every allowlisted root finds it too.
        assert_eq!(runtime.discover_agents(None).expect("scans all").len(), 1);

        // A root outside the allowlist is refused before any agent folder is scanned.
        let error = runtime
            .discover_agents(Some("/etc"))
            .expect_err("non-allowlisted root is refused");
        assert_eq!(error.code, "workspace_not_allowed");

        let _ = fs::remove_dir_all(&empty_home);
    }

    #[test]
    fn discover_agents_includes_the_user_global_scope() {
        let (_, workspace_root) = workspace_paths();
        // A project Claude agent in the allowlisted workspace.
        let project_dir = std::path::Path::new(&workspace_root).join(".claude/agents");
        fs::create_dir_all(&project_dir).expect("project agent dir");
        fs::write(
            project_dir.join("project-only.md"),
            "---\nname: Project Only\n---\nbody\n",
        )
        .expect("write project agent");

        // A user-global Claude agent under a pinned temp home (not the real home).
        let home = std::env::temp_dir().join(format!("honeyhub-home-{}", Uuid::new_v4()));
        let global_dir = home.join(".claude/agents");
        fs::create_dir_all(&global_dir).expect("global agent dir");
        fs::write(
            global_dir.join("global-only.md"),
            "---\nname: Global Only\n---\nbody\n",
        )
        .expect("write global agent");

        let runtime = BridgeRuntime::new(
            FakeAdapter::new(CapabilityFlags::claude_local()),
            WorkspaceAllowlist::new(vec![workspace_root.clone()]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal]),
        )
        .with_global_home(Some(home.clone()));

        // The global scope is scanned even when discovery is scoped to one workspace root.
        let scoped = runtime
            .discover_agents(Some(&workspace_root))
            .expect("scoped scan");
        assert!(scoped.iter().any(|a| a.name == "Project Only"));
        let global = scoped
            .iter()
            .find(|a| a.name == "Global Only")
            .expect("global agent surfaced");
        assert_eq!(
            global.backends[0].scope,
            crate::agents::AgentScope::Global,
            "the global definition is tagged global scope"
        );

        // Disabling the global home drops the global agent but keeps the project one.
        let no_global = runtime
            .with_global_home(None)
            .discover_agents(Some(&workspace_root))
            .expect("scoped scan without global");
        assert!(no_global.iter().any(|a| a.name == "Project Only"));
        assert!(!no_global.iter().any(|a| a.name == "Global Only"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn discover_agents_never_advertises_a_backend_the_runtime_cannot_launch() {
        // A single-adapter runtime can only launch its adapter's backend (`start` rejects
        // any other with `backend_mismatch`). Even if the backend allowlist is broader,
        // discovery must not advertise a binding that could not be launched.
        let (_, workspace_root) = workspace_paths();
        // A Claude agent and a Copilot agent in the same workspace.
        let claude_dir = std::path::Path::new(&workspace_root).join(".claude/agents");
        fs::create_dir_all(&claude_dir).expect("claude dir");
        fs::write(
            claude_dir.join("reviewer.md"),
            "---\nname: Reviewer\n---\nbody\n",
        )
        .expect("write claude agent");
        let copilot_dir = std::path::Path::new(&workspace_root).join(".copilot/agents");
        fs::create_dir_all(&copilot_dir).expect("copilot dir");
        fs::write(
            copilot_dir.join("reviewer.md"),
            "---\nname: Reviewer\n---\nbody\n",
        )
        .expect("write copilot agent");

        let empty_home = std::env::temp_dir().join(format!("honeyhub-home-{}", Uuid::new_v4()));
        fs::create_dir_all(&empty_home).expect("empty home");
        // Claude adapter, but the allowlist *also* contains Copilot — the loophole the
        // Grid flagged. `start` would still reject a Copilot session, so the catalog must
        // not advertise the Copilot binding.
        let runtime = BridgeRuntime::new(
            FakeAdapter::new(CapabilityFlags::claude_local()),
            WorkspaceAllowlist::new(vec![workspace_root.clone()]),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal, AgentBackend::CopilotLocal]),
        )
        .with_global_home(Some(empty_home.clone()));

        let agents = runtime
            .discover_agents(Some(&workspace_root))
            .expect("scan");
        // One entry by name, runnable on Claude only — the Copilot binding is dropped
        // because this runtime's adapter cannot launch it.
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "Reviewer");
        assert_eq!(
            agents[0].backends.len(),
            1,
            "only the launchable backend is advertised"
        );
        assert_eq!(agents[0].backends[0].backend, AgentBackend::ClaudeLocal);

        let _ = fs::remove_dir_all(&empty_home);
    }
}
