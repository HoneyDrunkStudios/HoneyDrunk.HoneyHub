//! Test fixture: a stand-in for the Codex CLI's `exec --json` mode, used by
//! `tests/codex_local.rs`. Unlike `fake_claude` (a live duplex process), Codex is
//! **non-interactive**: each turn is a `codex exec` process that emits a JSONL
//! stream and exits. A follow-up turn is a separate `codex exec --json resume <session>`
//! process. This fixture models exactly that — emit a thread id, one agent message
//! reflecting the run, the turn's exact token usage, then exit.
//!
//! It is std-only and emits hand-written JSON so the bridge crate gains no
//! dependency. It is not a product binary.

use std::io::{self, Write};

fn emit(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Escape a string for embedding inside a JSON string literal (std-only), so a task
/// containing quotes, backslashes, or control characters still produces valid JSONL.
fn json_escape(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `codex exec --json resume <session> [task]` (--json before the resume subcommand)
    let resumed = args.iter().any(|arg| arg == "resume");
    // The task is the last non-flag arg after `exec`/`resume`/`--json`, if any.
    let task = args
        .iter()
        .rev()
        .find(|arg| !arg.starts_with("--") && *arg != "resume" && *arg != "exec")
        .filter(|arg| !arg.ends_with("fake_codex") && !arg.ends_with("fake_codex.exe"))
        .cloned()
        .unwrap_or_default();

    let stdout = io::stdout();
    let mut out = stdout.lock();

    emit(
        &mut out,
        r#"{"type":"thread.started","thread_id":"codex-thread-1","model":"codex-fake"}"#,
    );

    let reply = if resumed {
        "resumed session".to_string()
    } else if task.is_empty() {
        "turn reply".to_string()
    } else {
        format!("reply to: {task}")
    };

    emit(
        &mut out,
        r#"{"type":"item.completed","item":{"type":"reasoning","text":"considering the request"}}"#,
    );
    emit(
        &mut out,
        &format!(
            r#"{{"type":"item.completed","item":{{"type":"agent_message","text":"{}"}}}}"#,
            json_escape(&reply)
        ),
    );
    emit(
        &mut out,
        r#"{"type":"turn.completed","model":"codex-fake","usage":{"input_tokens":100,"output_tokens":50}}"#,
    );
    // `codex exec` exits at end of turn (non-interactive).
}
