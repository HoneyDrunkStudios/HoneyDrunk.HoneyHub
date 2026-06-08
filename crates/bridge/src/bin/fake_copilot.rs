//! Test fixture: a stand-in for the GitHub Copilot CLI's `--json` mode, used by
//! `tests/copilot_local.rs`. Copilot streams token-level `assistant.message_delta`
//! events and is resume-based (each turn a fresh process), reporting
//! premium-requests + duration rather than tokens. This fixture emits a session id,
//! a few token deltas, then a `turn.completed` carrying the premium-request count,
//! and exits.
//!
//! It is std-only and emits hand-written JSON so the bridge crate gains no
//! dependency. It is not a product binary.

use std::io::{self, Write};

fn emit(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Escape a string for embedding inside a JSON string literal (std-only), so a delta
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
    let resumed = args.iter().any(|arg| arg == "--resume");

    let stdout = io::stdout();
    let mut out = stdout.lock();

    emit(
        &mut out,
        r#"{"type":"session.created","session_id":"copilot-sess-1","model":"claude-sonnet-4.6"}"#,
    );

    let deltas: &[&str] = if resumed {
        &["resumed ", "session"]
    } else {
        &["hello ", "from ", "copilot"]
    };
    for delta in deltas {
        emit(
            &mut out,
            &format!(
                r#"{{"type":"assistant.message_delta","delta":"{}"}}"#,
                json_escape(delta)
            ),
        );
    }

    emit(
        &mut out,
        r#"{"type":"turn.completed","model":"claude-sonnet-4.6","premium_requests":1,"duration_ms":1800}"#,
    );
    // Copilot CLI exits at end of turn (resume-based, non-interactive automation).
}
