#![cfg(feature = "test-fixtures")]
//! Integration test for the `copilot.local` adapter against a fake `copilot` binary
//! (`src/bin/fake_copilot.rs`). Copilot is token-level streaming and resume-based,
//! reporting premium-requests + duration rather than tokens, so this drives the real
//! process mechanism through a fresh turn (streamed deltas + estimated usage), a
//! follow-up resume, and an explicit resume.

use honeyhub_bridge::adapters::copilot_local::CopilotLocalAdapter;
use honeyhub_bridge::wire::{BridgeEvent, BridgeEventPayload};
use honeyhub_bridge::{
    AgentBackend, AgentBackendAdapter, DispatchSession, EventClock, StartRunRequest, UsageFidelity,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fake_program() -> &'static str {
    env!("CARGO_BIN_EXE_fake_copilot")
}

fn fixed_clock() -> EventClock {
    Arc::new(|| "2026-06-08T12:00:00Z".to_string())
}

fn session(workspace: &str) -> DispatchSession {
    DispatchSession {
        id: "session-1".to_string(),
        backend: AgentBackend::CopilotLocal,
        title: "Copilot lifecycle".to_string(),
        workspace_root: workspace.to_string(),
        created_at: "2026-06-08T12:00:00Z".to_string(),
        updated_at: "2026-06-08T12:00:00Z".to_string(),
        current_run_id: None,
    }
}

fn start_request(workspace: &str, run_id: &str, follow_up: Option<&str>) -> StartRunRequest {
    StartRunRequest {
        session: session(workspace),
        workspace_root: workspace.to_string(),
        task: "build the bridge".to_string(),
        model: None,
        agent: None,
        effort: None,
        requested_run_id: Some(run_id.to_string()),
        follow_up_to_run_id: follow_up.map(str::to_string),
        transcript: Vec::new(),
        launch_command: None,
    }
}

fn drain_until<F>(adapter: &CopilotLocalAdapter, run_id: &str, mut done: F) -> Vec<BridgeEvent>
where
    F: FnMut(&[BridgeEvent]) -> bool,
{
    let mut collected = Vec::new();
    // Poll with an explicit time deadline (ADR-0047: polling waits need a real
    // timeout, not a fixed sleep or an unbounded iteration count). `yield_now`
    // between polls keeps the loop from spinning a core flat-out.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        collected.extend(adapter.stream(run_id).expect("stream succeeds"));
        if done(&collected) {
            return collected;
        }
        std::thread::yield_now();
    }
    panic!(
        "predicate never satisfied within timeout; collected {} events",
        collected.len()
    );
}

fn has_usage(events: &[BridgeEvent]) -> bool {
    events
        .iter()
        .any(|event| matches!(event.payload, BridgeEventPayload::Usage { .. }))
}

fn partial_message_bodies(events: &[BridgeEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match &event.payload {
            BridgeEventPayload::Message { message } if message.is_partial == Some(true) => {
                Some(message.body.clone())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn drives_fake_copilot_through_token_streaming_lifecycle() {
    // Isolated per-test workspace (not the shared global temp root) so concurrent
    // tests cannot interfere.
    let workspace_dir = tempfile::tempdir().expect("temp workspace");
    let workspace = workspace_dir.path().to_string_lossy().to_string();
    let adapter = CopilotLocalAdapter::new(fake_program(), fixed_clock());

    adapter
        .start(start_request(&workspace, "run-1", None))
        .expect("copilot run starts");

    let first = drain_until(&adapter, "run-1", has_usage);
    // Token-level deltas surfaced as partial messages.
    let deltas = partial_message_bodies(&first);
    assert_eq!(deltas.join(""), "hello from copilot");

    let usage = first
        .iter()
        .find_map(|event| match &event.payload {
            BridgeEventPayload::Usage { signal } => Some(signal),
            _ => None,
        })
        .expect("an estimated usage signal");
    assert_eq!(usage.fidelity, UsageFidelity::Estimated);
    assert_eq!(usage.premium_requests, Some(1));
    assert_eq!(usage.duration_ms, Some(1800));
    // Tokens are estimated (present but tagged estimated), USD absent.
    assert!(usage.total_tokens.is_some());
    assert_eq!(usage.total_usd, None);
    assert_eq!(usage.backend, AgentBackend::CopilotLocal);

    // Follow-up turn resumes the captured session.
    adapter
        .start(start_request(&workspace, "run-2", Some("run-1")))
        .expect("follow-up run starts");
    let second = drain_until(&adapter, "run-2", has_usage);
    assert_eq!(partial_message_bodies(&second).join(""), "resumed session");

    adapter.stop("run-1").expect("stop run-1");
    adapter.stop("run-2").expect("stop run-2");

    // Explicit resume spawns a fresh process for the session.
    let resumed = adapter.resume("copilot-sess-1").expect("resume succeeds");
    let resumed_events = drain_until(&adapter, &resumed.run_id, has_usage);
    assert_eq!(
        partial_message_bodies(&resumed_events).join(""),
        "resumed session"
    );
    adapter.stop(&resumed.run_id).expect("stop resumed run");
}
