//! Cross-adapter helpers shared by the concrete `AgentBackendAdapter`
//! implementations.
//!
//! The terminal-transition emit is identical across every backend except for the
//! `AgentBackend` tag on each event, so it lives here once (parameterized by
//! backend) rather than being copy-pasted into each adapter. Behavior is fixed by
//! contract: a clean exit emits `[Finalizing, Completed]`; a non-zero exit emits
//! `[Failed]`.

use crate::adapter::AgentBackend;
use crate::session::DispatchRunState;
use crate::wire::{BridgeEvent, BridgeStatusEvent};
use uuid::Uuid;

/// Build one terminal status event for `backend` in `state`. The adapter sets
/// `sequence: 0`; the core re-stamps it on ingest.
pub(crate) fn terminal_status(
    backend: AgentBackend,
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
            backend,
            repo_hint: None,
            link: None,
        },
    )
}

/// Push the terminal transition events (exactly once) after the tail usage line, so
/// ordering is `[..usage, finalizing, completed]` on a clean exit or `[..usage, failed]`
/// on a non-zero exit.
pub(crate) fn push_terminal_status(
    events: &mut Vec<BridgeEvent>,
    backend: AgentBackend,
    success: bool,
    session_id: &str,
    run_id: &str,
    now: &str,
) {
    if success {
        events.push(terminal_status(
            backend,
            session_id,
            run_id,
            now,
            DispatchRunState::Finalizing,
        ));
        events.push(terminal_status(
            backend,
            session_id,
            run_id,
            now,
            DispatchRunState::Completed,
        ));
    } else {
        events.push(terminal_status(
            backend,
            session_id,
            run_id,
            now,
            DispatchRunState::Failed,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::BridgeEventPayload;

    fn states(events: &[BridgeEvent]) -> Vec<(DispatchRunState, AgentBackend)> {
        events
            .iter()
            .filter_map(|event| match &event.payload {
                BridgeEventPayload::Status { status } => {
                    Some((status.state.clone(), status.backend))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn terminal_status_tags_the_given_backend_and_state() {
        let event = terminal_status(
            AgentBackend::CodexLocal,
            "session-1",
            "run-1",
            "2026-06-13T00:00:00Z",
            DispatchRunState::Completed,
        );
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.run_id, "run-1");
        match &event.payload {
            BridgeEventPayload::Status { status } => {
                assert_eq!(status.state, DispatchRunState::Completed);
                assert_eq!(status.backend, AgentBackend::CodexLocal);
                assert!(status.repo_hint.is_none());
                assert!(status.link.is_none());
            }
            other => panic!("expected a status payload, got {other:?}"),
        }
    }

    #[test]
    fn success_pushes_finalizing_then_completed() {
        let mut events = Vec::new();
        push_terminal_status(
            &mut events,
            AgentBackend::ClaudeLocal,
            true,
            "session-1",
            "run-1",
            "2026-06-13T00:00:00Z",
        );
        assert_eq!(
            states(&events),
            vec![
                (DispatchRunState::Finalizing, AgentBackend::ClaudeLocal),
                (DispatchRunState::Completed, AgentBackend::ClaudeLocal),
            ]
        );
    }

    #[test]
    fn failure_pushes_only_failed() {
        let mut events = Vec::new();
        push_terminal_status(
            &mut events,
            AgentBackend::CopilotLocal,
            false,
            "session-1",
            "run-1",
            "2026-06-13T00:00:00Z",
        );
        assert_eq!(
            states(&events),
            vec![(DispatchRunState::Failed, AgentBackend::CopilotLocal)]
        );
    }
}
