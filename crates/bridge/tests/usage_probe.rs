//! Live-duplex coverage for the usage probe's full PTY loop, driven by the
//! `fake_usage_tui` fixture (the real vendor CLIs only run in the `#[ignore]`d
//! live test on the operator's machine). Exercises spawn, terminal-query replies,
//! boot detection, two-step typing, capture/settle, parsing, and the trust-prompt
//! abort — the paths CI coverage would otherwise never execute.
#![cfg(feature = "test-fixtures")]

use honeyhub_bridge::{probe_usage, AgentBackend};
use std::sync::Mutex;

fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_fake_usage_tui")
}

/// Serializes the two probe tests: the fixture's mode travels via a process-wide
/// env var the PTY child inherits, so the tests must not overlap.
static MODE_LOCK: Mutex<()> = Mutex::new(());

fn workspace() -> String {
    std::env::temp_dir()
        .join("honeyhub-usage-probe-test")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn probes_a_fake_tui_end_to_end_and_parses_its_meters() {
    let _guard = MODE_LOCK.lock().expect("mode lock");
    std::env::remove_var("FAKE_USAGE_TUI_MODE");
    std::fs::create_dir_all(workspace()).expect("workspace dir");
    let report = probe_usage(
        AgentBackend::ClaudeLocal,
        fixture(),
        &workspace(),
        "2026-07-04T00:00:00Z".to_string(),
    );
    assert!(report.ok, "raw: {}", report.raw);
    // The panel's meter lines parsed (vendor bar glyphs stripped, % normalized:
    // "95% left" renders as 5% used).
    assert!(
        report.windows.len() >= 3,
        "windows: {:?} raw: {}",
        report.windows,
        report.raw
    );
    let lines: Vec<&str> = report.windows.iter().map(|w| w.line.as_str()).collect();
    assert!(lines.iter().any(|l| l.contains("Current session")));
    assert!(lines.iter().any(|l| l.contains("61% used")));
    let left = report
        .windows
        .iter()
        .find(|w| w.line.contains("95% left"))
        .expect("percent-left meter");
    assert_eq!(left.used_percent, Some(5.0));
    // No bar glyphs leak into the cleaned lines.
    assert!(!report.raw.contains('█'));
}

#[test]
fn aborts_on_a_folder_trust_prompt_without_typing_into_it() {
    let _guard = MODE_LOCK.lock().expect("mode lock");
    std::env::set_var("FAKE_USAGE_TUI_MODE", "trust");
    std::fs::create_dir_all(workspace()).expect("workspace dir");
    let report = probe_usage(
        AgentBackend::ClaudeLocal,
        fixture(),
        &workspace(),
        "2026-07-04T00:00:00Z".to_string(),
    );
    std::env::remove_var("FAKE_USAGE_TUI_MODE");
    assert!(report.ok);
    assert!(report.windows.is_empty(), "windows: {:?}", report.windows);
    assert!(
        report.raw.contains("folder-trust prompt"),
        "raw: {}",
        report.raw
    );
    // The probe must never have typed into the dialog: the fixture converts any
    // received keystroke into this sentinel.
    assert!(!report.raw.contains("TYPED-INTO-TRUST-PROMPT"));
}
