//! CLI environment + update awareness (control-hub roadmap #8): the installed version of
//! each backend CLI, read by running `<program> --version`. Read-only and dependency-free.
//!
//! HONESTY: this reports the **installed** version only. It does not query npm / a release
//! registry for "the latest", because that needs a network call and the bridge holds no
//! vendor auth — so it never claims "an update is available". New-**model** awareness is a
//! separate, achievable thing: the UI diffs the freshly-detected model catalog (from
//! `detect_default_backends`, which re-reads each CLI's own cache) against the set it last
//! saw, and badges what's new. The Codex model cache is maintained by the Codex CLI itself;
//! "refresh" here means re-reading it, not forcing the CLI to repopulate it.

use crate::adapter::AgentBackend;
use crate::backend_catalog::{default_program, program_on_path};
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendVersion {
    pub backend: AgentBackend,
    pub program: String,
    /// True when the program resolves on PATH.
    pub available: bool,
    /// The parsed version string (e.g. `1.2.3`), when the CLI reported one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub backends: Vec<BackendVersion>,
}

/// Detect installed versions for the offered backends (Claude + Codex; Copilot is not
/// offered in the cockpit). Each runs `<program> --version` only when the program resolves.
pub fn detect_environment() -> EnvironmentInfo {
    let backends = [AgentBackend::ClaudeLocal, AgentBackend::CodexLocal]
        .into_iter()
        .map(|backend| {
            let program = default_program(backend);
            let available = program_on_path(program);
            let version = if available {
                run_version(program)
            } else {
                None
            };
            BackendVersion {
                backend,
                program: program.to_string(),
                available,
                version,
            }
        })
        .collect();
    EnvironmentInfo { backends }
}

/// Run `<program> --version` and parse a version token from its output. Best-effort: a
/// spawn failure or unparseable output yields `None`.
fn run_version(program: &str) -> Option<String> {
    let output = Command::new(program).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_version(&text).or_else(|| {
        // Some CLIs print the version to stderr.
        let err = String::from_utf8_lossy(&output.stderr);
        parse_version(&err)
    })
}

/// Extract the first version-like token (e.g. `1.2.3`, `0.41.0-beta`) from CLI output.
/// Pure, so it is unit-testable across the various `--version` formats.
pub fn parse_version(output: &str) -> Option<String> {
    for token in output.split(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        let trimmed = token.trim_start_matches('v');
        if is_version_token(trimmed) {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// A token is version-like when it starts `<digits>.<digits>` (optionally more dotted
/// segments and a trailing pre-release/build suffix like `-beta` or `+build`).
fn is_version_token(token: &str) -> bool {
    let core = token.split(['-', '+']).next().unwrap_or("");
    let mut segments = core.split('.');
    let first = segments.next();
    let second = segments.next();
    match (first, second) {
        (Some(a), Some(b)) => {
            !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
                && segments.all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_semver() {
        assert_eq!(parse_version("1.2.3\n").as_deref(), Some("1.2.3"));
    }

    #[test]
    fn parses_version_with_label_and_v_prefix() {
        assert_eq!(
            parse_version("claude-code v0.41.0 (build 9)").as_deref(),
            Some("0.41.0")
        );
    }

    #[test]
    fn parses_two_segment_and_prerelease() {
        assert_eq!(parse_version("codex 0.9-beta").as_deref(), Some("0.9-beta"));
    }

    #[test]
    fn rejects_non_version_output() {
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("v1"), None);
    }
}
