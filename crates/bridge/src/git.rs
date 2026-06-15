//! Git status + read-only diff (parity polish #9). The cockpit can't read the repo, so the
//! bridge shells out to `git` for a workspace's branch/ahead-behind/dirty status and a
//! read-only unified diff. **Read-only**: it only runs `git status`/`git diff` — never a
//! mutating command. The host gates the `root` against the workspace allowlist, exactly like
//! file reads, before calling here.

use crate::adapter::BridgeError;
use serde::{Deserialize, Serialize};
use std::process::Command;

/// Cap a diff so an enormous change never floods the wire (chars).
const MAX_DIFF_CHARS: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    /// The two-character porcelain XY code (e.g. ` M`, `A `, `??`).
    pub status: String,
    /// True when the change is staged (index column is not space/`?`).
    pub staged: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The root this status is for (echoed so the UI can correlate).
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
    pub clean: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub patch: String,
    pub truncated: bool,
}

/// Run `git status` for a repo root and parse it. Errors when `git` is missing or the
/// directory is not a work tree (the message is the trimmed git stderr).
pub fn status(root: &str) -> Result<GitStatus, BridgeError> {
    let output = Command::new("git")
        .args(["-C", root, "status", "--porcelain=v1", "--branch"])
        .output()
        .map_err(|error| BridgeError::new("git_unavailable", error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BridgeError::new(
            "git_status_failed",
            first_line(&stderr)
                .unwrap_or("git status failed")
                .to_string(),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_status(root, &text))
}

/// Run a read-only unified diff for a repo root (optionally one path), against `HEAD` so it
/// covers staged + unstaged changes. Capped at [`MAX_DIFF_CHARS`].
pub fn diff(root: &str, path: Option<&str>) -> Result<GitDiff, BridgeError> {
    let mut command = Command::new("git");
    command.args(["-C", root, "diff", "HEAD"]);
    if let Some(path) = path {
        command.arg("--").arg(path);
    }
    let output = command
        .output()
        .map_err(|error| BridgeError::new("git_unavailable", error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BridgeError::new(
            "git_diff_failed",
            first_line(&stderr).unwrap_or("git diff failed").to_string(),
        ));
    }
    let mut patch = String::from_utf8_lossy(&output.stdout).to_string();
    let truncated = patch.chars().count() > MAX_DIFF_CHARS;
    if truncated {
        patch = patch.chars().take(MAX_DIFF_CHARS).collect();
    }
    Ok(GitDiff {
        root: root.to_string(),
        path: path.map(str::to_string),
        patch,
        truncated,
    })
}

/// Parse `git status --porcelain=v1 --branch` output. Pure, so the branch/ahead-behind and
/// file-status parsing is unit-testable without a repo.
pub fn parse_status(root: &str, text: &str) -> GitStatus {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let (b, u, a, be) = parse_branch_line(rest);
            branch = b;
            upstream = u;
            ahead = a;
            behind = be;
        } else if line.len() >= 3 {
            let status = line[..2].to_string();
            let path = line[3..].to_string();
            let index = status.chars().next().unwrap_or(' ');
            files.push(GitFileStatus {
                untracked: status == "??",
                staged: index != ' ' && index != '?',
                status,
                path,
            });
        }
    }

    GitStatus {
        root: root.to_string(),
        branch,
        upstream,
        ahead,
        behind,
        clean: files.is_empty(),
        files,
    }
}

/// Parse the porcelain branch header body (after `## `):
/// `main...origin/main [ahead 1, behind 2]`, `main`, or `HEAD (no branch)`.
fn parse_branch_line(rest: &str) -> (Option<String>, Option<String>, u32, u32) {
    // Detached head: `HEAD (no branch)`.
    if rest.starts_with("HEAD (no branch)") {
        return (None, None, 0, 0);
    }
    // Split off the optional ` [ahead N, behind M]` tracking suffix.
    let (names, tracking) = match rest.split_once(" [") {
        Some((names, track)) => (names, Some(track.trim_end_matches(']'))),
        None => (rest, None),
    };
    let (branch, upstream) = match names.split_once("...") {
        Some((b, u)) => (Some(b.to_string()), Some(u.to_string())),
        None => (Some(names.trim().to_string()), None),
    };
    let (mut ahead, mut behind) = (0, 0);
    if let Some(track) = tracking {
        for part in track.split(',') {
            let part = part.trim();
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.trim().parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
    (branch, upstream, ahead, behind)
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_with_ahead_behind() {
        let text =
            "## main...origin/main [ahead 1, behind 2]\n M src/a.rs\n?? new.txt\nA  staged.txt\n";
        let status = parse_status("/repo", text);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 2);
        assert_eq!(status.files.len(), 3);
        assert!(!status.clean);

        let modified = &status.files[0];
        assert_eq!(modified.path, "src/a.rs");
        assert_eq!(modified.status, " M");
        assert!(!modified.staged);
        assert!(!modified.untracked);

        let untracked = &status.files[1];
        assert!(untracked.untracked);
        assert_eq!(untracked.path, "new.txt");

        let staged = &status.files[2];
        assert!(staged.staged);
        assert_eq!(staged.path, "staged.txt");
    }

    #[test]
    fn parses_clean_branch_without_upstream() {
        let status = parse_status("/repo", "## work-branch\n");
        assert_eq!(status.branch.as_deref(), Some("work-branch"));
        assert_eq!(status.upstream, None);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert!(status.clean);
    }

    #[test]
    fn handles_detached_head() {
        let status = parse_status("/repo", "## HEAD (no branch)\n");
        assert_eq!(status.branch, None);
        assert!(status.clean);
    }
}
