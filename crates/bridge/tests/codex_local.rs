#![cfg(feature = "test-fixtures")]
//! Integration test for the `codex.local` adapter against a fake `codex` binary
//! (`src/bin/fake_codex.rs`). Codex is **non-interactive** — each turn is a
//! `codex exec` process that streams JSONL and exits — so this drives the real
//! process mechanism for the resume-based model: a fresh turn, a follow-up turn
//! that resumes the captured vendor session, an explicit `resume`, and the
//! exact-tokens / derived-USD `turn.completed` usage.

use honeyhub_bridge::adapters::codex_local::{CodexLocalAdapter, UsdRateLookup};
use honeyhub_bridge::wire::{BridgeEvent, BridgeEventPayload};
use honeyhub_bridge::{
    AgentBackend, AgentBackendAdapter, DispatchSession, EventClock, StartRunRequest, UsageFidelity,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fake_program() -> &'static str {
    env!("CARGO_BIN_EXE_fake_codex")
}

fn fixed_clock() -> EventClock {
    Arc::new(|| "2026-06-08T12:00:00Z".to_string())
}

fn session(workspace: &str) -> DispatchSession {
    DispatchSession {
        pinned: false,
        id: "session-1".to_string(),
        backend: AgentBackend::CodexLocal,
        title: "Codex lifecycle".to_string(),
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
        attachments: Vec::new(),
        parent_run_id: None,
        parent_session_id: None,
    }
}

fn drain_until<F>(adapter: &CodexLocalAdapter, run_id: &str, mut done: F) -> Vec<BridgeEvent>
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

fn agent_message_bodies(events: &[BridgeEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match &event.payload {
            BridgeEventPayload::Message { message } => Some(message.body.clone()),
            _ => None,
        })
        .collect()
}

fn has_usage(events: &[BridgeEvent]) -> bool {
    events
        .iter()
        .any(|event| matches!(event.payload, BridgeEventPayload::Usage { .. }))
}

#[test]
fn drives_fake_codex_through_resume_based_lifecycle() {
    let workspace = std::env::temp_dir().to_string_lossy().to_string();
    let adapter = CodexLocalAdapter::new(fake_program(), fixed_clock());

    // Fresh turn: exec runs to completion, streaming an agent message + usage.
    let handle = adapter
        .start(start_request(&workspace, "run-1", None))
        .expect("codex run starts");
    assert_eq!(handle.run_id, "run-1");

    let first = drain_until(&adapter, "run-1", has_usage);
    assert!(
        agent_message_bodies(&first)
            .iter()
            .any(|body| body == "reply to: build the bridge"),
        "expected the agent message reflecting the task, got {:?}",
        agent_message_bodies(&first)
    );
    // Reasoning items are not surfaced as messages.
    assert!(!agent_message_bodies(&first)
        .iter()
        .any(|body| body.contains("considering")));

    let usage = first
        .iter()
        .find_map(|event| match &event.payload {
            BridgeEventPayload::Usage { signal } => Some(signal),
            _ => None,
        })
        .expect("a usage signal from turn.completed");
    assert_eq!(usage.fidelity, UsageFidelity::Derived);
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(50));
    assert_eq!(usage.total_tokens, Some(150));
    // No rate table wired -> exact tokens, USD absent (never fabricated).
    assert_eq!(usage.total_usd, None);
    assert_eq!(usage.backend, AgentBackend::CodexLocal);

    // Follow-up turn (the core's resume-based reply path): start with
    // follow_up_to_run_id resumes the prior run's captured vendor session.
    let follow_up = adapter
        .start(start_request(&workspace, "run-2", Some("run-1")))
        .expect("follow-up run starts");
    assert_eq!(follow_up.run_id, "run-2");
    let second = drain_until(&adapter, "run-2", has_usage);
    assert!(
        agent_message_bodies(&second)
            .iter()
            .any(|body| body == "resumed session"),
        "follow-up should resume the vendor session, got {:?}",
        agent_message_bodies(&second)
    );

    adapter.stop("run-1").expect("stop run-1");
    adapter.stop("run-2").expect("stop run-2");

    // Explicit resume spawns a fresh exec resume process for the session.
    let resumed = adapter.resume("codex-thread-1").expect("resume succeeds");
    assert_ne!(resumed.run_id, "run-1");
    let resumed_events = drain_until(&adapter, &resumed.run_id, |events| {
        agent_message_bodies(events)
            .iter()
            .any(|body| body == "resumed session")
    });
    assert!(agent_message_bodies(&resumed_events)
        .iter()
        .any(|body| body == "resumed session"));
    adapter.stop(&resumed.run_id).expect("stop resumed run");
}

#[test]
fn derives_usd_from_injected_rate_table() {
    let workspace = std::env::temp_dir().to_string_lossy().to_string();
    // A toy rate: flat $0.01 for any turn with token counts.
    let rate: UsdRateLookup = Arc::new(|_model, _input, _output| Some(0.01));
    let adapter = CodexLocalAdapter::with_rate_lookup(fake_program(), fixed_clock(), rate);

    adapter
        .start(start_request(&workspace, "run-1", None))
        .expect("codex run starts");
    let events = drain_until(&adapter, "run-1", has_usage);
    let usage = events
        .iter()
        .find_map(|event| match &event.payload {
            BridgeEventPayload::Usage { signal } => Some(signal),
            _ => None,
        })
        .expect("a usage signal");
    assert_eq!(usage.fidelity, UsageFidelity::Derived);
    assert_eq!(usage.total_usd, Some(0.01));
    adapter.stop("run-1").expect("stop run-1");
}
