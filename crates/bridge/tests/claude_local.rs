#![cfg(feature = "test-fixtures")]
//! Integration test for the `claude.local` adapter against a **live duplex** fake
//! `claude` binary (`src/bin/fake_claude.rs`). The fake reacts to stdin replies
//! and terminates on kill, so this exercises the real process mechanism —
//! start -> stream -> needs_input -> reply -> stop -> resume — and the exact-USD
//! `result`-event usage emission. A static recorded fixture cannot prove `reply`
//! or `stop`, so this drives a real child process.

use honeyhub_bridge::wire::{BridgeEvent, BridgeEventPayload};
use honeyhub_bridge::{
    AgentBackend, AgentBackendAdapter, ClaudeLocalAdapter, DispatchRunState, DispatchSession,
    EventClock, StartRunRequest,
};
use std::sync::Arc;
use std::time::Duration;

fn fake_program() -> &'static str {
    env!("CARGO_BIN_EXE_fake_claude")
}

fn fixed_clock() -> EventClock {
    Arc::new(|| "2026-06-07T12:00:00Z".to_string())
}

fn session(workspace: &str) -> DispatchSession {
    DispatchSession {
        id: "session-1".to_string(),
        backend: AgentBackend::ClaudeLocal,
        title: "Claude lifecycle".to_string(),
        workspace_root: workspace.to_string(),
        created_at: "2026-06-07T12:00:00Z".to_string(),
        updated_at: "2026-06-07T12:00:00Z".to_string(),
        current_run_id: None,
    }
}

fn drain_until<F>(adapter: &ClaudeLocalAdapter, run_id: &str, mut done: F) -> Vec<BridgeEvent>
where
    F: FnMut(&[BridgeEvent]) -> bool,
{
    let mut collected = Vec::new();
    for _ in 0..250 {
        collected.extend(adapter.stream(run_id).expect("stream succeeds"));
        if done(&collected) {
            return collected;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!(
        "predicate never satisfied; collected {} events",
        collected.len()
    );
}

fn is_needs_input(event: &BridgeEvent) -> bool {
    matches!(
        &event.payload,
        BridgeEventPayload::Status { status } if status.state == DispatchRunState::NeedsInput
    )
}

fn is_agent_message(event: &BridgeEvent, body: &str) -> bool {
    matches!(
        &event.payload,
        BridgeEventPayload::Message { message } if message.body == body
    )
}

#[test]
fn drives_fake_claude_through_full_lifecycle() {
    let workspace = std::env::temp_dir().to_string_lossy().to_string();
    let adapter = ClaudeLocalAdapter::new(fake_program(), None, fixed_clock());

    let request = StartRunRequest {
        session: session(&workspace),
        workspace_root: workspace,
        task: "build the bridge".to_string(),
        requested_run_id: Some("run-1".to_string()),
        follow_up_to_run_id: None,
        transcript: Vec::new(),
        launch_command: None,
    };

    let handle = adapter.start(request).expect("claude run starts");
    assert_eq!(handle.run_id, "run-1");
    assert!(handle.process_id.is_some());

    // Turn 1: streamed assistant text, a detected PR artifact, then needs_input.
    let first = drain_until(&adapter, "run-1", |events| {
        events.iter().any(is_needs_input)
    });
    assert!(first
        .iter()
        .any(|event| is_agent_message(event, "turn 1 reply")));
    assert!(first.iter().any(|event| matches!(
        &event.payload,
        BridgeEventPayload::Artifact { artifact }
            if matches!(artifact.kind, honeyhub_bridge::ArtifactKind::PullRequest)
    )));

    // Same-process live reply changes the output (proves interactive_reply).
    adapter
        .reply("run-1", "continue")
        .expect("live reply accepted");
    let second = drain_until(&adapter, "run-1", |events| {
        events
            .iter()
            .any(|event| matches!(event.payload, BridgeEventPayload::Usage { .. }))
    });
    assert!(second
        .iter()
        .any(|event| is_agent_message(event, "turn 2 reply")));

    let usage = second
        .iter()
        .find_map(|event| match &event.payload {
            BridgeEventPayload::Usage { signal } => Some(signal),
            _ => None,
        })
        .expect("a usage signal is emitted from the result event");
    assert_eq!(usage.fidelity, honeyhub_bridge::UsageFidelity::Exact);
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(50));
    assert_eq!(usage.total_tokens, Some(150));
    assert_eq!(usage.total_usd, Some(0.0123));
    assert_eq!(usage.backend, AgentBackend::ClaudeLocal);

    // Stop is graceful even though the turn-2 result already ended the process.
    adapter.stop("run-1").expect("stop succeeds");

    // Resume spawns a fresh live process that re-attaches to the session.
    let resumed = adapter.resume("fake-session-1").expect("resume succeeds");
    assert_ne!(resumed.run_id, "run-1");
    assert!(resumed.process_id.is_some());
    let resumed_events = drain_until(&adapter, &resumed.run_id, |events| {
        events
            .iter()
            .any(|event| is_agent_message(event, "resumed session"))
    });
    assert!(resumed_events
        .iter()
        .any(|event| is_agent_message(event, "resumed session")));
    adapter.stop(&resumed.run_id).expect("stop resumed run");
}
