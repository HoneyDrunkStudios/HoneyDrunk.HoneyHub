//! Group checks: run a **named, host-owned** check (the repo's build/test) in a repo
//! root and report the outcome. This is the "run & test a change group" half of the
//! multi-worktree review flow — the cockpit fires one check per member repo and
//! aggregates pass/fail.
//!
//! Trust model (cockpit-not-terminal boundary): the client never supplies a command
//! line. It sends a **check id**; the host resolves that id against its own
//! definitions — the built-in set below, which the operator's `HONEYHUB_EXTRA_CHECKS`
//! env table (`{"<id>": ["<program>", "<arg>", ...], ...}`) may extend or override —
//! and refuses anything else with an explicit `denied` outcome. Roots are additionally
//! gated against the workspace allowlist by the host before calling in here (the same
//! posture as a git write). Argv is spawned directly (no shell); bare program names
//! resolve through `PATH`/`PATHEXT` so `npm` finds `npm.cmd` on Windows, and relative
//! paths anchor to the repo root. Output capture is capped while streaming, and on
//! timeout (`HONEYHUB_CHECK_TIMEOUT_SECS`, default 600s) the **whole process tree** is
//! killed (the same `taskkill /T` / `killpg` mechanics the run driver uses), with a
//! bounded grace on output collection — so a hung or watch-mode check can never wedge
//! the bridge or strand the per-root in-flight slot.

use crate::adapters::child_run::{kill_process_tree, put_in_own_process_group};
use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Cap captured output so a noisy test run never floods the wire (chars).
const MAX_OUTPUT_CHARS: usize = 40_000;
/// Cap each stream while reading (bytes), so a runaway check cannot balloon memory
/// before the wire clamp. The remainder is drained (not stored) to avoid pipe stalls.
const MAX_STREAM_BYTES: usize = 256 * 1024;
/// Default wall-clock budget for one check before its process tree is killed.
const DEFAULT_TIMEOUT_SECS: u64 = 600;
/// How often the runner polls the child for exit while the budget lasts.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// How long to wait for the capped output after the child is gone. Readers signal
/// through a channel (never joined unconditionally), so even a straggler process
/// holding the pipes open cannot wedge the runner — the output is just cut short.
const READER_GRACE: Duration = Duration::from_secs(2);

/// The built-in named checks: id → argv. Host-owned by construction; mirrored by the
/// cockpit's check picker (packages/ui/src/routes/groups/checksModel.ts).
const BUILTIN_CHECKS: &[(&str, &[&str])] = &[
    ("npm-test", &["npm", "test"]),
    ("npm-build", &["npm", "run", "build"]),
    ("cargo-test", &["cargo", "test", "--workspace"]),
    ("dotnet-test", &["dotnet", "test"]),
    ("go-test", &["go", "test", "./..."]),
    ("pytest", &["pytest"]),
    ("make-test", &["make", "test"]),
];

/// How a check request was disposed of — explicit, so denied/timed-out runs are
/// observable states rather than indistinguishable failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckDisposition {
    /// The check ran to completion (pass or fail per `ok`/`exit_code`).
    Ran,
    /// The request was refused: unknown check id, or a check already in flight.
    Denied,
    /// The resolved program could not be spawned or supervised.
    SpawnFailed,
    /// The check exceeded its wall-clock budget and its process tree was killed.
    TimedOut,
}

/// The outcome of running one named check in a repo root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    /// The repo root the check ran in (echoed so the UI can correlate).
    pub root: String,
    /// The check id as requested (echoed for correlation).
    pub check: String,
    /// The resolved command line (display only), or the id when nothing resolved.
    pub command: String,
    /// True when the process ran and exited 0.
    pub ok: bool,
    /// How the request was disposed of (ran / denied / spawn_failed / timed_out).
    pub disposition: CheckDisposition,
    /// The process exit code, when one was returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Combined stdout + stderr, trimmed and clamped to [`MAX_OUTPUT_CHARS`].
    pub output: String,
    /// True when `output` was clamped (wire clamp or stream cap).
    pub truncated: bool,
}

impl CheckOutcome {
    /// An outcome for a check that never ran to completion normally: `ok = false`,
    /// surfaced inline like a failed git write, never a transport error.
    fn not_run(
        root: &str,
        check: &str,
        command: impl Into<String>,
        disposition: CheckDisposition,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            root: root.to_string(),
            check: check.to_string(),
            command: command.into(),
            ok: false,
            disposition,
            exit_code: None,
            output: reason.into(),
            truncated: false,
        }
    }

    /// A denied request (unknown check id, overlapping run).
    pub fn denied(root: &str, check: &str, reason: impl Into<String>) -> Self {
        Self::not_run(root, check, check, CheckDisposition::Denied, reason)
    }
}

/// Parse the operator's `HONEYHUB_EXTRA_CHECKS` JSON (`{"<id>": ["prog", ...]}`).
/// Entries with an empty argv or non-string members are dropped; any parse failure
/// yields an empty table. An entry reusing a built-in id **overrides** it — the
/// operator owns the host and its definitions.
pub fn parse_extra_checks(json: &str) -> HashMap<String, Vec<String>> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return HashMap::new();
    };
    let Some(entries) = value.as_object() else {
        return HashMap::new();
    };
    entries
        .iter()
        .filter_map(|(id, argv)| {
            let argv: Vec<String> = argv
                .as_array()?
                .iter()
                .map(|part| part.as_str().map(str::to_string))
                .collect::<Option<Vec<String>>>()?;
            (!argv.is_empty()).then(|| (id.clone(), argv))
        })
        .collect()
}

/// The full ordered check table: the built-ins (each possibly overridden by an
/// operator extra with the same id), then extra-only ids, sorted. Parsed fresh per
/// request — checks run at human click frequency.
fn check_table() -> Vec<(String, Vec<String>)> {
    let mut extras =
        parse_extra_checks(&std::env::var("HONEYHUB_EXTRA_CHECKS").unwrap_or_default());
    let mut table: Vec<(String, Vec<String>)> = BUILTIN_CHECKS
        .iter()
        .map(|(id, argv)| {
            let argv = extras
                .remove(*id)
                .unwrap_or_else(|| argv.iter().map(|part| (*part).to_string()).collect());
            ((*id).to_string(), argv)
        })
        .collect();
    let mut rest: Vec<(String, Vec<String>)> = extras.into_iter().collect();
    rest.sort_by(|a, b| a.0.cmp(&b.0));
    table.extend(rest);
    table
}

/// Resolve a check id to its host-owned argv. `None` = not an allowed check.
pub fn resolve_check(id: &str) -> Option<Vec<String>> {
    check_table()
        .into_iter()
        .find(|(check_id, _)| check_id == id)
        .map(|(_, argv)| argv)
}

/// The wall-clock budget for one check: `HONEYHUB_CHECK_TIMEOUT_SECS`, default 600s.
fn check_timeout() -> Duration {
    let secs = std::env::var("HONEYHUB_CHECK_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Read a stream keeping at most `cap` bytes; the remainder is drained and discarded
/// so the child never blocks on a full pipe. Returns the kept text (lossy UTF-8) and
/// whether anything was discarded.
fn read_capped<R: Read>(mut reader: R, cap: usize) -> (String, bool) {
    let mut kept: Vec<u8> = Vec::new();
    let mut overflowed = false;
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let room = cap.saturating_sub(kept.len());
                if room >= count {
                    kept.extend_from_slice(&buffer[..count]);
                } else {
                    kept.extend_from_slice(&buffer[..room]);
                    overflowed = true;
                }
            }
            Err(_) => break,
        }
    }
    (String::from_utf8_lossy(&kept).into_owned(), overflowed)
}

/// Combine stdout + stderr into one block, trim it, and clamp to `max` chars. Returns the
/// text and whether it was clamped. Pure, so the clamp/append logic is unit-testable.
pub fn clamp_output(stdout: &str, stderr: &str, max: usize) -> (String, bool) {
    let mut combined = stdout.trim().to_string();
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr);
    }
    if combined.chars().count() > max {
        let clamped: String = combined.chars().take(max).collect();
        (clamped, true)
    } else {
        (combined, false)
    }
}

/// Resolve the program to launch for a check running in `root`: absolute paths pass
/// through, relative paths **with separators anchor to the repo root** (never the
/// host's cwd), and bare names walk `PATH`/`PATHEXT` (so `npm` → `npm.cmd`). An
/// unresolvable name falls through as-is and surfaces as a spawn failure.
fn resolve_check_program(root: &str, program: &str) -> OsString {
    let path = Path::new(program);
    if path.is_absolute() {
        return program.into();
    }
    if program.contains('/') || program.contains('\\') {
        return Path::new(root).join(path).into_os_string();
    }
    resolve_program(program)
        .map(std::path::PathBuf::into_os_string)
        .unwrap_or_else(|| program.into())
}

/// Run the named check `check` in `root` and report the outcome. Never returns an
/// error: an unknown id, spawn failure, or timeout becomes an `ok = false` outcome
/// with an explicit disposition, so the cockpit shows it inline next to the repo.
/// The host gates `root` against the allowlist (and serializes per-root runs)
/// before calling this.
pub fn run_check(root: &str, check: &str) -> CheckOutcome {
    let table = check_table();
    let Some((_, argv)) = table.iter().find(|(check_id, _)| check_id == check) else {
        let allowed: Vec<&str> = table.iter().map(|(id, _)| id.as_str()).collect();
        return CheckOutcome::denied(
            root,
            check,
            format!(
                "`{check}` is not an allowed check; allowed: {}",
                allowed.join(", ")
            ),
        );
    };
    run_argv(root, check, argv, check_timeout())
}

/// Spawn the resolved argv and supervise it: capped streaming capture on both pipes,
/// exit polling against the wall-clock budget, and a process-tree kill on timeout.
fn run_argv(root: &str, check: &str, argv: &[String], timeout: Duration) -> CheckOutcome {
    let display = argv.join(" ");
    let program = &argv[0];
    let resolved = resolve_check_program(root, program);

    let mut command = Command::new(&resolved);
    command
        .args(&argv[1..])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group (unix), so the timeout kill below can take the whole tree.
    put_in_own_process_group(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CheckOutcome::not_run(
                root,
                check,
                display,
                CheckDisposition::SpawnFailed,
                format!("could not run `{program}`: {error}"),
            );
        }
    };

    // Readers drain both pipes concurrently (a full pipe would deadlock the child)
    // and report through channels — the supervisor never joins them unconditionally,
    // so a straggler process holding a pipe open cannot wedge the runner.
    let spawn_reader = |stream: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel::<(String, bool)>();
        if let Some(stream) = stream {
            std::thread::spawn(move || {
                let _ = tx.send(read_capped(stream, MAX_STREAM_BYTES));
            });
        } else {
            let _ = tx.send((String::new(), false));
        }
        rx
    };
    let stdout_rx = spawn_reader(
        child
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    );
    let stderr_rx = spawn_reader(
        child
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn Read + Send>),
    );

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut supervisor_error: Option<String> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    kill_process_tree(&mut child);
                    break None;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                // The supervisor can no longer monitor the child: tear the tree down
                // rather than leak it, and report the runner-level failure honestly.
                supervisor_error = Some(error.to_string());
                kill_process_tree(&mut child);
                break None;
            }
        }
    };

    // Bounded collection: if a straggler still holds a pipe, cut the output short
    // instead of waiting on it.
    let mut capture_aborted = false;
    let mut collect =
        |rx: std::sync::mpsc::Receiver<(String, bool)>| match rx.recv_timeout(READER_GRACE) {
            Ok(result) => result,
            Err(_) => {
                capture_aborted = true;
                (String::new(), true)
            }
        };
    let (stdout, stdout_capped) = collect(stdout_rx);
    let (stderr, stderr_capped) = collect(stderr_rx);
    let (mut text, clamped) = clamp_output(&stdout, &stderr, MAX_OUTPUT_CHARS);
    let mut push_note = |note: &str| {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(note);
    };
    if timed_out {
        push_note(&format!(
            "… check timed out after {}s and its process tree was killed",
            timeout.as_secs()
        ));
    }
    if let Some(error) = &supervisor_error {
        push_note(&format!(
            "… the check runner could not supervise the process and killed it: {error}"
        ));
    }
    if capture_aborted {
        push_note("… output capture was cut short (a child process kept the pipes open)");
    }

    let disposition = if timed_out {
        CheckDisposition::TimedOut
    } else if supervisor_error.is_some() {
        CheckDisposition::SpawnFailed
    } else {
        CheckDisposition::Ran
    };
    CheckOutcome {
        root: root.to_string(),
        check: check.to_string(),
        command: display,
        ok: disposition == CheckDisposition::Ran
            && status
                .as_ref()
                .is_some_and(std::process::ExitStatus::success),
        disposition,
        exit_code: status.and_then(|status| status.code()),
        output: text,
        truncated: clamped || stdout_capped || stderr_capped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_builtin_checks_and_denies_everything_else() {
        assert_eq!(
            resolve_check("npm-test"),
            Some(vec!["npm".to_string(), "test".to_string()])
        );
        assert_eq!(resolve_check("rm -rf /"), None);
        assert_eq!(resolve_check("pwsh"), None);
        assert_eq!(resolve_check(""), None);
    }

    #[test]
    fn unknown_check_is_a_denied_outcome_not_an_execution() {
        let outcome = run_check(".", "definitely-not-a-check; rm -rf /");
        assert!(!outcome.ok);
        assert_eq!(outcome.disposition, CheckDisposition::Denied);
        assert_eq!(outcome.exit_code, None);
        assert!(outcome.output.contains("not an allowed check"));
        assert!(outcome.output.contains("npm-test"));
    }

    #[test]
    fn parses_extra_checks_and_drops_garbage() {
        let table = parse_extra_checks(
            r#"{
                "lint": ["npm", "run", "lint"],
                "empty": [],
                "not-strings": ["ok", 42]
            }"#,
        );
        assert_eq!(table.len(), 1);
        assert_eq!(
            table.get("lint"),
            Some(&vec![
                "npm".to_string(),
                "run".to_string(),
                "lint".to_string()
            ])
        );
        assert!(parse_extra_checks("not json").is_empty());
        assert!(parse_extra_checks("[]").is_empty());
        assert!(parse_extra_checks("").is_empty());
    }

    #[test]
    fn check_program_resolution_anchors_relative_paths_to_the_repo() {
        // Bare names go through PATH; relative separator paths anchor to the root
        // (never the host cwd); absolute paths pass through.
        let anchored = resolve_check_program("/repo", "scripts/ci.sh");
        assert_eq!(
            anchored,
            OsString::from(Path::new("/repo").join("scripts/ci.sh"))
        );
        #[cfg(unix)]
        assert_eq!(
            resolve_check_program("/repo", "/bin/sh"),
            OsString::from("/bin/sh")
        );
    }

    #[test]
    fn read_capped_keeps_prefix_and_flags_overflow() {
        let (text, overflowed) = read_capped(std::io::Cursor::new(b"hello world".to_vec()), 5);
        assert_eq!(text, "hello");
        assert!(overflowed);
        let (text, overflowed) = read_capped(std::io::Cursor::new(b"tiny".to_vec()), 100);
        assert_eq!(text, "tiny");
        assert!(!overflowed);
    }

    #[test]
    fn clamps_and_appends_streams() {
        assert_eq!(
            clamp_output("out", "err", 100),
            ("out\nerr".to_string(), false)
        );
        assert_eq!(clamp_output("  out  ", "", 100), ("out".to_string(), false));
        assert_eq!(clamp_output("", "  err ", 100), ("err".to_string(), false));

        let (text, truncated) = clamp_output("abcdefghij", "", 4);
        assert_eq!(text, "abcd");
        assert!(truncated);
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_check_kills_the_tree_and_reports() {
        let outcome = run_argv(
            ".",
            "slow",
            &["sleep".to_string(), "30".to_string()],
            Duration::from_millis(300),
        );
        assert!(!outcome.ok);
        assert_eq!(outcome.disposition, CheckDisposition::TimedOut);
        assert!(outcome.output.contains("timed out"));
    }

    #[cfg(windows)]
    #[test]
    fn timed_out_check_kills_the_tree_and_reports() {
        // `ping -n 30 127.0.0.1` runs ~29s; the runner must kill it at the budget.
        let outcome = run_argv(
            ".",
            "slow",
            &[
                "ping".to_string(),
                "-n".to_string(),
                "30".to_string(),
                "127.0.0.1".to_string(),
            ],
            Duration::from_millis(500),
        );
        assert!(!outcome.ok);
        assert_eq!(outcome.disposition, CheckDisposition::TimedOut);
        assert!(outcome.output.contains("timed out"));
    }

    #[test]
    fn spawn_failure_is_an_explicit_disposition() {
        let outcome = run_argv(
            ".",
            "ghost",
            &["definitely-not-a-real-program-xyz".to_string()],
            Duration::from_secs(5),
        );
        assert!(!outcome.ok);
        assert_eq!(outcome.disposition, CheckDisposition::SpawnFailed);
        assert!(outcome.output.contains("could not run"));
    }
}
