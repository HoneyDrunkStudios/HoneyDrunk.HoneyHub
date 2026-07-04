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
use crate::backend_catalog::resolve_program;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Wall-clock budget for one probe (spawn + render + capture). Interactive TUIs can
/// take seconds to boot; the default leaves slack without letting a hang wedge.
const DEFAULT_TIMEOUT_SECS: u64 = 25;

/// How long the capture waits after output goes quiet before concluding the TUI has
/// finished a phase (the TUIs repaint in bursts, and boot does background work like
/// MCP-server startup between paints).
const QUIET_MS: u64 = 2500;

/// Minimum time the capture keeps collecting after typing the slash command, so a
/// panel that renders late (observed: Codex paints /status well after its banner)
/// is not cut off by an early quiet period.
const POST_SEND_MIN_MS: u64 = 5000;

/// Hard ceiling on waiting for boot quiescence before typing anyway. Codex keeps a
/// spinner repainting through its MCP-server startup, so a quiet period may NEVER
/// come — but its composer is usable long before startup finishes (observed live).
const BOOT_MAX_MS: u64 = 8000;

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

/// True when `haystack` contains `needle` as a byte subsequence.
fn contains_seq(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Answer the terminal-capability queries a booting TUI blocks on. The probe IS the
/// terminal, so unanswered queries stall the CLI before it paints anything (observed
/// live: Claude Code sends a cursor-position request, `ESC[6n`, and waits).
fn respond_to_terminal_queries(chunk: &[u8], writer: &mut (impl std::io::Write + ?Sized)) {
    // DSR 6 (cursor position report): reply "row 1, col 1".
    if contains_seq(chunk, b"\x1b[6n") {
        let _ = writer.write_all(b"\x1b[1;1R");
    }
    // Primary device attributes: claim a VT220-class terminal.
    if contains_seq(chunk, b"\x1b[c") || contains_seq(chunk, b"\x1b[0c") {
        let _ = writer.write_all(b"\x1b[?62c");
    }
    let _ = writer.flush();
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
/// chrome, and spinner noise; trim and de-duplicate repaints GLOBALLY (interactive
/// TUIs repaint the same lines many times, interleaved, as they redraw).
fn clean_lines(stripped: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    for raw_line in stripped.lines() {
        // Drop box-drawing chrome (U+2500–U+257F) AND the vendors' inline meter-bar
        // glyphs (block elements, U+2580–U+259F) — the cockpit draws its own bars.
        // The glyphs act as separators so their removal never fuses two words.
        let line: String = raw_line
            .chars()
            .map(|ch| {
                if ('\u{2500}'..='\u{259f}').contains(&ch) {
                    ' '
                } else {
                    ch
                }
            })
            .collect();
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        // Un-smoosh the column-layout collapse the capture produces
        // ("0%usedResets 12:49pm" → "0% used · Resets 12:49pm").
        let line = line
            .replace("%used", "% used")
            .replace("used Resets", "used · Resets")
            .replace("usedResets", "used · Resets");
        if line.is_empty() {
            continue;
        }
        if seen.insert(line.clone()) {
            lines.push(line);
        }
    }
    lines
}

/// Pull the meter lines out of the cleaned panel text. Two passes:
/// 1. **High signal** — the vendors' own meter shape ("Current session … 34% used …",
///    "… limit left …"), skipping smooshed multi-segment repaint lines (length cap).
/// 2. **Fallback** — when no meter-shaped line exists, anything carrying a percent or
///    a usage keyword next to a number, so an unknown layout still surfaces SOMETHING.
fn parse_windows(lines: &[String]) -> Vec<UsageWindow> {
    let meter_shaped = |line: &String| {
        let lower = line.to_lowercase();
        let metered = lower.contains("% used")
            || lower.contains("%used")
            || lower.contains("% left")
            || lower.contains("limit left")
            || lower.contains("resets available")
            // A per-model group header ("GPT-5.3-Codex-Spark limit:") labels the
            // meters under it.
            || lower.ends_with("limit:");
        metered && line.chars().count() <= 140
    };
    let meters: Vec<&String> = lines.iter().filter(|line| meter_shaped(line)).collect();
    if !meters.is_empty() {
        return meters
            .into_iter()
            .map(|line| window_from_line(line))
            .collect();
    }
    let keywords = ["session", "week", "limit", "reset", "usage", "used", "left"];
    lines
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            line.contains('%')
                || (keywords.iter().any(|keyword| lower.contains(keyword))
                    && lower.chars().any(|ch| ch.is_ascii_digit()))
        })
        .map(|line| window_from_line(line))
        .collect()
}

/// Build a window from a meter line, normalizing to USED percent: Claude reports
/// "% used", Codex reports "% left" — the bar always shows consumption.
fn window_from_line(line: &str) -> UsageWindow {
    let percent = first_percent(line);
    let used_percent = percent.map(|value| {
        if line.to_lowercase().contains("% left") {
            (100.0 - value).max(0.0)
        } else {
            value
        }
    });
    UsageWindow {
        line: line.to_string(),
        used_percent,
    }
}

/// The first "NN%" or "NN.N%" on the line, as a number. Char-safe: TUI panels mix
/// multi-byte glyphs (meter bars like `█`) into the same line as the digits.
fn first_percent(line: &str) -> Option<f32> {
    let index = line.find('%')?;
    let digits: Vec<char> = line[..index]
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    let number: String = digits.into_iter().rev().collect();
    number.parse::<f32>().ok().filter(|value| *value >= 0.0)
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

    // Resolve the CLI through PATH/PATHEXT (the adapters' resolver): on Windows the
    // npm shims are `claude.cmd` / `codex.cmd`, which CreateProcess cannot launch
    // bare — batch shims must run under `cmd /c`.
    let resolved = resolve_program(program)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string());
    let lower = resolved.to_lowercase();
    let batch_shim = lower.ends_with(".cmd") || lower.ends_with(".bat");

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
    let mut builder = if batch_shim {
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.arg("/c");
        builder.arg(&resolved);
        builder
    } else {
        CommandBuilder::new(&resolved)
    };
    builder.cwd(cwd);
    let mut child = match pair.slave.spawn_command(builder) {
        Ok(child) => child,
        Err(error) => return not_run(format!("could not launch {resolved}: {error}")),
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
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    eprintln!("[usage-probe] reader: EOF");
                    break;
                }
                Ok(count) => {
                    if sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    eprintln!("[usage-probe] reader error: {error}");
                    break;
                }
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

    // Capture loop: wait for the TUI to boot (it must have PAINTED something and
    // then gone quiet — a quiet period before any output just means it is still
    // starting), type the slash command, then capture until the panel settles or
    // the budget runs out.
    let started = Instant::now();
    let deadline = started + probe_timeout();
    let quiet = Duration::from_millis(QUIET_MS);
    let post_send_min = Duration::from_millis(POST_SEND_MIN_MS);
    let boot_max = Duration::from_millis(BOOT_MAX_MS);
    let mut captured: Vec<u8> = Vec::new();
    let mut typed_at: Option<Instant> = None;
    let mut sent_at: Option<Instant> = None;
    let mut last_output = Instant::now();
    loop {
        if Instant::now() >= deadline {
            break;
        }
        // Two-step typing, like a human: the command text first, Enter ~700ms later.
        // Sending "\r" in the same write gets swallowed by the slash-command popup
        // the TUIs open mid-typing (observed live: Codex left "/status" sitting in
        // its composer). The text goes once the TUI painted and either went idle OR
        // has been booting past the ceiling (a background spinner can repaint
        // forever while the composer is already usable — Codex during MCP startup).
        if sent_at.is_none() && !captured.is_empty() {
            match typed_at {
                None if last_output.elapsed() >= quiet || started.elapsed() >= boot_max => {
                    let _ = writer.write_all(command_text.as_bytes());
                    let _ = writer.flush();
                    typed_at = Some(Instant::now());
                }
                Some(when) if when.elapsed() >= Duration::from_millis(700) => {
                    let _ = writer.write_all(b"\r");
                    let _ = writer.flush();
                    sent_at = Some(Instant::now());
                    last_output = Instant::now();
                }
                _ => {}
            }
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                respond_to_terminal_queries(&chunk, &mut writer);
                captured.extend_from_slice(&chunk);
                last_output = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Done when the panel rendered and settled (with a minimum render
                // window, so a late paint after the send is not cut off). A spinner
                // that never settles simply rides to the deadline.
                if let Some(when) = sent_at {
                    if when.elapsed() >= post_send_min && last_output.elapsed() >= quiet {
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // An early exit (crash, not-a-tty bailout) is part of the answer.
    let exit_note = match child.try_wait() {
        Ok(Some(status)) => format!("\n[probe] the CLI exited early: {status}"),
        _ => String::new(),
    };
    let _ = child.kill();

    if std::env::var("HONEYHUB_USAGE_PROBE_DEBUG").is_ok() {
        eprintln!("[usage-probe] captured {} bytes", captured.len());
        let _ = std::fs::write(
            std::env::temp_dir().join(format!("honeyhub-probe-{backend:?}.bin")),
            &captured,
        );
    }
    let stripped = strip_ansi(&String::from_utf8_lossy(&captured));
    let lines = clean_lines(&stripped);
    // Claude Code gates untrusted folders behind an interactive safety prompt. The
    // probe never answers it for the operator (trusting a folder is their call, made
    // in the CLI itself) — it reports the stall instead.
    let trust_note =
        if stripped.contains("Quick safety check") || stripped.contains("trust this folder") {
            "[probe] Claude Code is waiting on its folder-trust prompt for this workspace. \
         Open Claude Code there once, accept the prompt, then re-check.\n"
        } else {
            ""
        };
    let windows = if trust_note.is_empty() {
        parse_windows(&lines)
    } else {
        Vec::new()
    };
    UsageProbeReport {
        backend,
        ok: true,
        windows,
        raw: format!("{trust_note}{}{exit_note}", lines.join("\n")),
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

    /// Live validation against the real CLIs on the operator's machine — the panel
    /// timing/layout cannot be exercised headlessly in CI. Run explicitly with:
    /// `cargo test -p honeyhub-bridge live_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "drives the real vendor CLIs; operator machine only"]
    fn live_probe_against_installed_clis() {
        // Run from the repo root — a folder the operator's CLIs already trust.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        for (backend, program) in [
            (AgentBackend::ClaudeLocal, "claude"),
            (AgentBackend::CodexLocal, "codex"),
        ] {
            let report = probe_usage(backend, program, root, "live".to_string());
            println!(
                "=== {backend:?} ok={} windows={}",
                report.ok,
                report.windows.len()
            );
            for window in &report.windows {
                println!("  [{:?}%] {}", window.used_percent, window.line);
            }
            println!("--- raw ---\n{}\n", report.raw);
        }
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
