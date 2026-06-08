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
            &format!(r#"{{"type":"assistant.message_delta","delta":"{delta}"}}"#),
        );
    }

    emit(
        &mut out,
        r#"{"type":"turn.completed","model":"claude-sonnet-4.6","premium_requests":1,"duration_ms":1800}"#,
    );
    // Copilot CLI exits at end of turn (resume-based, non-interactive automation).
}
