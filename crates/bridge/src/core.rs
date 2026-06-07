use crate::adapter::{AgentBackendAdapter, BridgeError, RunHandle, StartRunRequest};
use crate::pairing::WorkspaceAllowlist;
use crate::process::{ProcessExitStatus, ProcessHandle};
use crate::session::{
    DispatchControlEventKind, DispatchMessage, DispatchRun, DispatchRunRecord, DispatchRunState,
    DispatchSession,
};
use crate::wire::{BridgeEvent, BridgeEventPayload};
use std::collections::HashMap;
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
}

pub struct BridgeRuntime<A>
where
    A: AgentBackendAdapter,
{
    adapter: A,
    workspace_allowlist: WorkspaceAllowlist,
    runs: HashMap<String, ManagedRun>,
}

impl<A> BridgeRuntime<A>
where
    A: AgentBackendAdapter,
{
    pub fn new(adapter: A, workspace_allowlist: WorkspaceAllowlist) -> Self {
        Self {
            adapter,
            workspace_allowlist,
            runs: HashMap::new(),
        }
    }

    pub fn start(
        &mut self,
        mut request: StartRunRequest,
        created_at: impl Into<String>,
    ) -> Result<RunHandle, BridgeError> {
        let created_at = created_at.into();
        self.ensure_workspace_allowed(&request.workspace_root)?;
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
        record.transition_to(DispatchRunState::Queued, created_at.clone())?;
        record.transition_to(DispatchRunState::Starting, created_at.clone())?;
        record.append_event(
            DispatchControlEventKind::Launch,
            created_at.clone(),
            "launch recorded",
        )?;
        record.transition_to(DispatchRunState::Running, created_at.clone())?;

        let process = ProcessHandle::launched(
            handle.run_id.clone(),
            None,
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
        self.run(run_id)?;

        let events = self.adapter.stream(run_id)?;
        for event in &events {
            if event.run_id != run_id {
                return Err(BridgeError::new(
                    "event_run_mismatch",
                    "stream event run id does not match requested run",
                ));
            }
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
                _ => {}
            }
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
        self.run(run_id)?;
        let capabilities = self.adapter.capabilities();
        if capabilities.interactive_reply {
            self.adapter.reply(run_id, text)?;
            let managed = self.run_mut(run_id)?;
            if managed.record.run.state == DispatchRunState::NeedsInput {
                managed
                    .record
                    .transition_to(DispatchRunState::Running, created_at.clone())?;
            }
            managed.record.append_event(
                DispatchControlEventKind::Reply,
                created_at,
                "interactive reply accepted",
            )?;
            return Ok(ReplyOutcome::LiveReplyAccepted);
        }

        let managed = self.run(run_id)?.clone();
        let request = StartRunRequest {
            session: managed.session,
            workspace_root: managed.workspace_root,
            task: text.to_string(),
            requested_run_id: Some(Uuid::new_v4().to_string()),
            follow_up_to_run_id: Some(run_id.to_string()),
            transcript: managed.transcript,
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
                original
                    .record
                    .transition_to(DispatchRunState::Finalizing, created_at.clone())?;
                original
                    .record
                    .transition_to(DispatchRunState::Completed, created_at.clone())?;
            }
            original.record.append_event(
                DispatchControlEventKind::FollowUp,
                created_at.clone(),
                "reply routed to follow-up run",
            )?;
        }

        let mut record = DispatchRunRecord::new(DispatchRun::new(
            handle.run_id.clone(),
            request.session.id.clone(),
            request.task.clone(),
        ));
        record.transition_to(DispatchRunState::Queued, created_at.clone())?;
        record.transition_to(DispatchRunState::Starting, created_at.clone())?;
        record.append_event(
            DispatchControlEventKind::Launch,
            created_at.clone(),
            "follow-up launch recorded",
        )?;
        record.transition_to(DispatchRunState::Running, created_at.clone())?;

        self.runs.insert(
            handle.run_id.clone(),
            ManagedRun {
                session: request.session,
                workspace_root: request.workspace_root,
                record,
                process: ProcessHandle::launched(
                    handle.run_id.clone(),
                    None,
                    request.launch_command.unwrap_or_default(),
                    created_at,
                ),
                transcript: request.transcript,
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
        managed
            .record
            .transition_to(DispatchRunState::Stopping, created_at.clone())?;
        managed.record.append_event(
            DispatchControlEventKind::Stop,
            created_at,
            "stop requested",
        )?;
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

        managed.record.append_event(
            DispatchControlEventKind::Timeout,
            created_at,
            "graceful stop timed out; escalation required",
        )?;
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
        if exit.success {
            match managed.record.run.state {
                DispatchRunState::Stopping => {
                    managed
                        .record
                        .transition_to(DispatchRunState::Cancelled, exit.exited_at.clone())?;
                }
                DispatchRunState::Finalizing => {
                    managed
                        .record
                        .transition_to(DispatchRunState::Completed, exit.exited_at.clone())?;
                }
                _ => {
                    managed
                        .record
                        .transition_to(DispatchRunState::Finalizing, exit.exited_at.clone())?;
                    managed
                        .record
                        .transition_to(DispatchRunState::Completed, exit.exited_at.clone())?;
                }
            }
        } else {
            managed.record.run.failure_reason = Some(exit.summary());
            managed
                .record
                .transition_to(DispatchRunState::Failed, exit.exited_at.clone())?;
        }
        managed.record.append_event(
            DispatchControlEventKind::ProcessExit,
            exit.exited_at,
            "process exit recorded",
        )?;
        Ok(())
    }

    pub fn run(&self, run_id: &str) -> Result<&ManagedRun, BridgeError> {
        self.runs
            .get(run_id)
            .ok_or_else(|| BridgeError::new("run_not_found", format!("run {run_id} not found")))
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
            managed.record.transition_to(next, created_at)?;
        }
        Ok(())
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
        replies: RefCell<Vec<String>>,
        stops: RefCell<Vec<String>>,
    }

    impl FakeAdapter {
        fn new(capabilities: CapabilityFlags) -> Self {
            Self {
                capabilities,
                starts: RefCell::new(0),
                start_requests: RefCell::new(Vec::new()),
                replies: RefCell::new(Vec::new()),
                stops: RefCell::new(Vec::new()),
            }
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
            })
        }

        fn stream(&self, run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
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
                        backend: "claude.local".to_string(),
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
        let mut runtime =
            BridgeRuntime::new(adapter, WorkspaceAllowlist::new(vec![allowlist_root]));

        let handle = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect("run starts");
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
        let mut runtime = BridgeRuntime::new(adapter, WorkspaceAllowlist::new(vec![other_root]));

        let error = runtime
            .start(request(&workspace_root), "2026-06-07T12:00:00Z")
            .expect_err("outside workspace is denied");

        assert_eq!(error.code, "workspace_not_allowed");
    }

    #[test]
    fn routes_reply_to_follow_up_when_backend_is_not_interactive() {
        let (allowlist_root, workspace_root) = workspace_paths();
        let mut capabilities = CapabilityFlags::claude_local();
        capabilities.interactive_reply = false;
        let adapter = FakeAdapter::new(capabilities);
        let mut runtime =
            BridgeRuntime::new(adapter, WorkspaceAllowlist::new(vec![allowlist_root]));
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
        let mut runtime =
            BridgeRuntime::new(adapter, WorkspaceAllowlist::new(vec![allowlist_root]));
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
        let mut runtime =
            BridgeRuntime::new(adapter, WorkspaceAllowlist::new(vec![allowlist_root]));
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
}
