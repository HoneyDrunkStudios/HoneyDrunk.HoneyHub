//! Group checks: run a declared command (the repo's build/test) in a repo root and report
//! the outcome. This is the "run & test a change group" half of the multi-worktree review
//! flow — the cockpit fires one check per member repo and aggregates pass/fail.
//!
//! Like the git **writes** in [`crate::git`], running a command crosses the bridge's
//! normally read-only boundary, so the host gates every `root` against the workspace
//! allowlist before calling in here (the same posture as a git write). The command is run
//! **shell-free**: it is tokenized on whitespace and the program is spawned directly with
//! its args, so there is no shell-metacharacter / injection surface — a declared
//! `npm test` or `cargo test --workspace` works, an attempt to chain `; rm -rf` does not.

use serde::{Deserialize, Serialize};
use std::process::Command;

/// Cap captured output so a noisy test run never floods the wire (chars).
const MAX_OUTPUT_CHARS: usize = 40_000;

/// The outcome of running one declared check command in a repo root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    /// The repo root the command ran in (echoed so the UI can correlate).
    pub root: String,
    /// The command line as declared (echoed for display).
    pub command: String,
    /// True when the process exited 0.
    pub ok: bool,
    /// The process exit code, when one was returned (absent if killed by a signal or the
    /// program could not be spawned).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Combined stdout + stderr, trimmed and clamped to [`MAX_OUTPUT_CHARS`].
    pub output: String,
    /// True when `output` was clamped.
    pub truncated: bool,
}

impl CheckOutcome {
    /// A non-runnable outcome (empty command, spawn failure): `ok = false`, no exit code,
    /// the reason as output. Surfaced inline like a failed git write, not a transport error.
    fn unrunnable(root: &str, command: &str, reason: impl Into<String>) -> Self {
        Self {
            root: root.to_string(),
            command: command.to_string(),
            ok: false,
            exit_code: None,
            output: reason.into(),
            truncated: false,
        }
    }
}

/// Split a declared command line into (program, args), tokenizing on ASCII whitespace.
/// Returns `None` when the line has no program token. Shell-free on purpose (see module
/// docs): quoting and metacharacters are not interpreted.
pub fn parse_command(command: &str) -> Option<(String, Vec<String>)> {
    let mut parts = command.split_whitespace().map(str::to_string);
    let program = parts.next()?;
    Some((program, parts.collect()))
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

/// Run a declared check `command` in `root` and report the outcome. Never returns an error:
/// an empty command or a spawn failure becomes an `ok = false` outcome so the cockpit can
/// show it inline next to the repo rather than as a transport error. The host gates `root`
/// against the allowlist before calling this.
pub fn run_check(root: &str, command: &str) -> CheckOutcome {
    let Some((program, args)) = parse_command(command) else {
        return CheckOutcome::unrunnable(root, command, "no command to run");
    };

    let output = match Command::new(&program)
        .args(&args)
        .current_dir(root)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return CheckOutcome::unrunnable(
                root,
                command,
                format!("could not run `{program}`: {error}"),
            );
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let (text, truncated) = clamp_output(&stdout, &stderr, MAX_OUTPUT_CHARS);

    CheckOutcome {
        root: root.to_string(),
        command: command.to_string(),
        ok: output.status.success(),
        exit_code: output.status.code(),
        output: text,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_program_and_args() {
        assert_eq!(
            parse_command("cargo test --workspace"),
            Some(("cargo".to_string(), vec!["test".to_string(), "--workspace".to_string()]))
        );
        assert_eq!(parse_command("npm  test"), Some(("npm".to_string(), vec!["test".to_string()])));
        assert_eq!(parse_command("   "), None);
        assert_eq!(parse_command(""), None);
    }

    #[test]
    fn clamps_and_appends_streams() {
        assert_eq!(clamp_output("out", "err", 100), ("out\nerr".to_string(), false));
        assert_eq!(clamp_output("  out  ", "", 100), ("out".to_string(), false));
        assert_eq!(clamp_output("", "  err ", 100), ("err".to_string(), false));

        let (text, truncated) = clamp_output("abcdefghij", "", 4);
        assert_eq!(text, "abcd");
        assert!(truncated);
    }

    #[test]
    fn empty_command_is_an_unrunnable_outcome() {
        let outcome = run_check("/tmp", "   ");
        assert!(!outcome.ok);
        assert_eq!(outcome.exit_code, None);
        assert_eq!(outcome.output, "no command to run");
        assert_eq!(outcome.command, "   ");
    }

    #[test]
    fn missing_program_is_an_unrunnable_outcome() {
        let outcome = run_check(".", "definitely-not-a-real-program-xyz --version");
        assert!(!outcome.ok);
        assert_eq!(outcome.exit_code, None);
        assert!(outcome.output.contains("could not run"));
    }
}
