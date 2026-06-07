//! Test fixture: a **live duplex** stand-in for the Claude Code CLI's
//! `stream-json` mode, used by `tests/claude_local.rs`. A static recorded fixture
//! cannot prove `reply` (the output must change in response to a written reply)
//! or `stop` (the process must actually terminate on kill), so this is a real
//! process that reads line-delimited `user` JSON from stdin and emits a
//! responsive JSONL stream on stdout, blocking on stdin until killed.
//!
//! It is std-only and emits hand-written JSON so the bridge crate gains no
//! dependency. It is not a product binary.

use std::io::{self, BufRead, Write};

fn emit(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn main() {
    let resumed = std::env::args().any(|arg| arg == "-r");

    let stdout = io::stdout();
    let mut out = stdout.lock();

    emit(
        &mut out,
        r#"{"type":"system","subtype":"init","session_id":"fake-session-1","model":"claude-fake"}"#,
    );
    if resumed {
        emit(
            &mut out,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"resumed session"}]}}"#,
        );
    }

    let stdin = io::stdin();
    let mut turn = 0u32;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        turn += 1;

        // A token delta, then a full assistant turn that reflects the input so a
        // written reply visibly changes the output.
        emit(
            &mut out,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"thinking..."}}}"#,
        );
        emit(
            &mut out,
            &format!(
                r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"turn {turn} reply"}}]}}}}"#
            ),
        );

        if turn == 1 {
            // First turn opens an artifact and then asks for input, staying alive.
            emit(
                &mut out,
                r#"{"type":"artifact","kind":"pull_request","label":"Open PR","href":"https://example.test/pr/1"}"#,
            );
            emit(&mut out, r#"{"type":"needs_input"}"#);
        } else {
            // A later turn reports exact usage + USD and ends the session.
            emit(
                &mut out,
                r#"{"type":"result","subtype":"success","session_id":"fake-session-1","num_turns":2,"duration_ms":1234,"total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}"#,
            );
            break;
        }
    }
}
