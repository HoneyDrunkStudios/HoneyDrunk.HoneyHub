//! One-shot usage probes: ask the vendor CLIs what plan headroom remains.
//!
//! Neither CLI exposes its usage meters headlessly — `/usage` (Claude Code) and
//! `/status` (Codex) only exist inside the interactive TUIs. So the probe launches
//! the CLI in a **hidden, host-owned PTY**, types the slash command, captures the
//! rendered panel, strips the ANSI control sequences, extracts the usage lines, and
//! kills the process. It is a fire-and-report action in the ADR-0096 named-action
//! family: host-owned command choice, one-shot (no interactive surface reaches a
//! client), supervised with a wall-clock budget, and the result travels as a
//! host-synthesized device-wide event.
//!
//! Honesty rules: the numbers shown are the vendors' own meters at probe time
//! (`captured_at` is stamped by the host). Parsing is deliberately loose — when the
//! panel's layout changes, the probe still reports the raw captured text so the
//! answer degrades to unformatted rather than wrong. Screen-scraping is the accepted
//! trade until the vendors expose the meters programmatically.

use crate::adapter::AgentBackend;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Wall-clock budget for one probe (spawn + render + capture). Interactive TUIs can
/// take seconds to boot; the default leaves slack without letting a hang wedge.
const DEFAULT_TIMEOUT_SECS: u64 = 25;

/// How long the capture waits after output goes quiet before concluding the panel
/// has fully rendered (the TUIs repaint in bursts).
const QUIET_MS: u64 = 1500;

fn probe_timeout() -> Duration {
    let secs = std::env::var("HONEYHUB_USAGE_PROBE_TIMEOUT_SECS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// One meter line extracted from the panel (e.g. "Current session · 34% used").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// The cleaned line as the vendor rendered it (label + numbers + reset time).
    pub line: String,
    /// The first percentage on the line, when one parsed — powers a meter bar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f32>,
}

/// The outcome of probing one backend's usage meters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProbeReport {
    pub backend: AgentBackend,
    /// True when the probe ran and captured output (parsed or not); false when the
    /// CLI could not be spawned at all (reason in `raw`).
    pub ok: bool,
    /// Meter lines extracted from the panel, in render order. Empty when parsing
    /// found nothing — `raw` is then the answer.
    pub windows: Vec<UsageWindow>,
    /// The full captured panel text, ANSI-stripped and de-noised: the fallback the
    /// UI shows when `windows` is empty, and the audit trail when it is not.
    pub raw: String,
    /// Host timestamp for "as of when" (RFC3339, stamped by the caller's clock).
    pub captured_at: String,
}

/// The slash command that opens a backend's usage panel, or `None` when the backend
/// has no known usage surface (Copilot's CLI exposes none today).
fn usage_command(backend: AgentBackend) -> Option<&'static str> {
    match backend {
        AgentBackend::ClaudeLocal => Some("/usage"),
        AgentBackend::CodexLocal => Some("/status"),
        AgentBackend::CopilotLocal => None,
    }
}

/// Strip ANSI escape sequences (CSI/OSC/simple ESC) so panel text is inspectable.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch == '\r' {
                continue;
            }
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ ... final byte in @-~
            Some('[') => {
                for follow in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&follow) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                let mut prior_esc = false;
                for follow in chars.by_ref() {
                    if follow == '\u{7}' || (prior_esc && follow == '\\') {
                        break;
                    }
                    prior_esc = follow == '\u{1b}';
                }
            }
            // Two-byte escapes (ESC c, ESC =, …): the consumed char IS the sequence.
            _ => {}
        }
    }
    out
}

/// Collapse the stripped capture to meaningful lines: drop blanks, box-drawing
/// chrome, and spinner noise; trim and de-duplicate consecutive repaints.
fn clean_lines(stripped: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw_line in stripped.lines() {
        let line: String = raw_line
            .chars()
            .filter(|ch| !('\u{2500}'..='\u{257f}').contains(ch))
            .collect();
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        if lines.last().map(String::as_str) != Some(line.as_str()) {
            lines.push(line);
        }
    }
    lines
}

/// Pull the meter lines out of the cleaned panel text: anything carrying a percent,
/// or a session/week/limit/reset keyword next to a number.
fn parse_windows(lines: &[String]) -> Vec<UsageWindow> {
    let keywords = ["session", "week", "limit", "reset", "usage", "used", "left"];
    lines
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            line.contains('%')
                || (keywords.iter().any(|keyword| lower.contains(keyword))
                    && lower.chars().any(|ch| ch.is_ascii_digit()))
        })
        .map(|line| UsageWindow {
            line: line.clone(),
            used_percent: first_percent(line),
        })
        .collect()
}

/// The first "NN%" or "NN.N%" on the line, as a number.
fn first_percent(line: &str) -> Option<f32> {
    let index = line.find('%')?;
    let head = &line[..index];
    let start = head
        .rfind(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .map_or(0, |position| position + 1);
    head[start..]
        .parse::<f32>()
        .ok()
        .filter(|value| *value >= 0.0)
}

/// Probe one backend's usage meters. `program` is the CLI to launch (the caller
/// resolves overrides), `cwd` the directory to run in (a trusted workspace root, so
/// the CLI does not stall on a first-run trust prompt), and `captured_at` the host
/// clock stamp. Never returns an error: a spawn failure is an `ok: false` report.
pub fn probe_usage(
    backend: AgentBackend,
    program: &str,
    cwd: &str,
    captured_at: String,
) -> UsageProbeReport {
    let not_run = |reason: String| UsageProbeReport {
        backend,
        ok: false,
        windows: Vec::new(),
        raw: reason,
        captured_at: captured_at.clone(),
    };
    let Some(command_text) = usage_command(backend) else {
        return not_run("this backend exposes no usage surface".to_string());
    };

    let pty = native_pty_system();
    let pair = match pty.openpty(PtySize {
        rows: 40,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => return not_run(format!("could not open a pty: {error}")),
    };
    let mut builder = CommandBuilder::new(program);
    builder.cwd(cwd);
    let mut child = match pair.slave.spawn_command(builder) {
        Ok(child) => child,
        Err(error) => return not_run(format!("could not launch {program}: {error}")),
    };
    drop(pair.slave);

    // Reader thread: forward captured chunks over a channel so the supervisor can
    // apply the wall-clock budget and quiet-period detection without blocking.
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return not_run(format!("could not read the pty: {error}"));
        }
    };
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 || sender.send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return not_run(format!("could not write to the pty: {error}"));
        }
    };

    // Capture loop: wait for the TUI to boot (first quiet period), type the slash
    // command, then capture until the panel settles or the budget runs out.
    let deadline = Instant::now() + probe_timeout();
    let quiet = Duration::from_millis(QUIET_MS);
    let mut captured: Vec<u8> = Vec::new();
    let mut sent_command = false;
    let mut last_output = Instant::now();
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                captured.extend_from_slice(&chunk);
                last_output = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_output.elapsed() >= quiet {
                    if sent_command {
                        break; // The panel rendered and settled.
                    }
                    // The TUI booted and went idle: type the command + Enter.
                    let _ = writer.write_all(format!("{command_text}\r").as_bytes());
                    let _ = writer.flush();
                    sent_command = true;
                    last_output = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();

    let stripped = strip_ansi(&String::from_utf8_lossy(&captured));
    let lines = clean_lines(&stripped);
    let windows = parse_windows(&lines);
    UsageProbeReport {
        backend,
        ok: true,
        windows,
        raw: lines.join("\n"),
        captured_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_and_extracts_percent_meters() {
        let panel = "\u{1b}[2J\u{1b}[1;1H┌────────┐\r\nCurrent session\u{1b}[33m: 34% used\u{1b}[0m (resets 3pm)\r\n│\r\nCurrent week (all models): 61% used\r\nSonnet weekly limit: 12% used\r\nesc to dismiss\r\n";
        let lines = clean_lines(&strip_ansi(panel));
        let windows = parse_windows(&lines);
        assert_eq!(windows.len(), 3, "windows: {windows:?}");
        assert_eq!(windows[0].used_percent, Some(34.0));
        assert!(windows[0].line.contains("resets 3pm"));
        assert_eq!(windows[1].used_percent, Some(61.0));
        assert_eq!(windows[2].used_percent, Some(12.0));
    }

    #[test]
    fn keyword_lines_without_percent_still_surface_and_noise_does_not() {
        let lines =
            clean_lines("Weekly limit resets Tue 10:00\nGPT-5 credits left: 420\njust prose\n");
        let windows = parse_windows(&lines);
        assert_eq!(windows.len(), 2, "windows: {windows:?}");
        assert_eq!(windows[0].used_percent, None);
        assert!(windows[1].line.contains("420"));
    }

    #[test]
    fn copilot_has_no_usage_surface_and_reports_not_run() {
        let report = probe_usage(
            AgentBackend::CopilotLocal,
            "copilot",
            ".",
            "2026-07-03T00:00:00Z".to_string(),
        );
        assert!(!report.ok);
        assert!(report.raw.contains("no usage surface"));
    }
}
