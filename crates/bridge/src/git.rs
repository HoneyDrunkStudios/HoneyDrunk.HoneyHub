//! Git status, diffs, repo discovery, and (confirmation-gated) write operations.
//!
//! The cockpit can't touch the repo, so the bridge shells out to `git`. Reads (status,
//! diff, branches, repo discovery, the multi-repo overview) are unconditional. **Writes**
//! (stage/unstage/commit/push/pull/checkout/discard) cross the bridge's normally read-only
//! boundary (ADR-0090 D9, the artifact/write-boundary decision); they are a scoped,
//! confirmation-gated exception driven from the Git screen, the same posture the Service Bus
//! explorer uses for its destructive ops (ADR-0094 D5). The host gates every `root` against the
//! workspace allowlist first.
//!
//! Repo discovery makes the screen "smart": people add a *folder* of repos as a workspace
//! root, which has no `.git` of its own, so [`discover_repos`] returns the folder itself
//! when it is a repo, otherwise every repo found by a bounded recursive walk below it.

use crate::adapter::BridgeError;
use serde::{Deserialize, Serialize};
use std::path::Path;
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

/// Both versions of a single file for a side-by-side diff view: its content at `HEAD`
/// (the committed baseline) and in the working tree. Powers the Monaco `DiffEditor`, which
/// needs the two full texts rather than a unified patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileVersions {
    /// The repo root this is for (echoed so the UI can correlate).
    pub root: String,
    /// The repo-relative path (echoed so the UI can correlate).
    pub path: String,
    /// The file content at `HEAD` (empty when the path is not in `HEAD`, e.g. a new file).
    pub original: String,
    /// The working-tree file content (empty when the file was deleted from disk).
    pub modified: String,
    /// True when the path existed in `HEAD` (distinguishes a new file from an empty one).
    pub existed_in_head: bool,
    /// True when the file exists in the working tree (distinguishes a deleted file from empty).
    pub existed_in_work: bool,
}

/// The git status of every repo discovered under a selected folder (or just the one repo
/// when the selected root is itself a repo). Powers the multi-repo dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOverview {
    /// The selected folder/root this overview is for (echoed so the UI can correlate).
    pub root: String,
    /// One status per discovered repo, sorted by path.
    pub repos: Vec<GitStatus>,
}

/// A repo's local branches and which one is checked out (for the branch switcher).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub branches: Vec<String>,
}

/// The outcome of a git write operation, surfaced to the UI as feedback (the host also
/// re-emits a fresh `GitStatus` for the repo so the view updates).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub root: String,
    /// The operation name (e.g. `commit`, `push`, `pull`, `checkout`, `stage`, `discard`).
    pub op: String,
    pub ok: bool,
    /// A short human message (git's output, or the error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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

/// Read both sides of a single file for the side-by-side diff view: its `HEAD` (committed)
/// content and its working-tree content. `path` is repo-relative (like [`diff`]'s path).
///
/// **original** is `git -C <root> show HEAD:<path>`. When the path is not tracked in `HEAD`
/// (a newly-added file), git exits non-zero — that is treated as "absent from HEAD" (empty
/// content, `existed_in_head = false`), not an error. **modified** is the working-tree file
/// read directly from `<root>/<path>`; a missing file (deleted in the working tree) yields
/// empty content with `existed_in_work = false`.
pub fn file_versions(root: &str, path: &str) -> Result<GitFileVersions, BridgeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("show")
        .arg(format!("HEAD:{path}"))
        .output()
        .map_err(|error| BridgeError::new("git_unavailable", error.to_string()))?;
    let (original, existed_in_head) = if output.status.success() {
        (String::from_utf8_lossy(&output.stdout).to_string(), true)
    } else {
        // A path absent from HEAD (new file) is not an error — git reports it on a
        // non-zero exit ("exists on disk, but not in 'HEAD'" / "does not exist in 'HEAD'").
        (String::new(), false)
    };

    // Guard the working-tree read against a client-supplied `path` escaping the repo root
    // (path traversal): only read when the file's canonical location is inside the canonical
    // root. `canonicalize` also requires existence, so a deleted file (or a `..` escape that
    // does not resolve) simply yields an absent `modified`. This keeps the read inside the
    // allowlisted root the host already gated, matching the bridge's read-posture boundary.
    let work_path = Path::new(root).join(path);
    let within_root = match (work_path.canonicalize(), Path::new(root).canonicalize()) {
        (Ok(resolved), Ok(canonical_root)) if resolved.starts_with(&canonical_root) => {
            Some(resolved)
        }
        _ => None,
    };
    let (modified, existed_in_work) = match within_root {
        Some(resolved) => match std::fs::read(&resolved) {
            Ok(bytes) => (String::from_utf8_lossy(&bytes).to_string(), true),
            Err(_) => (String::new(), false),
        },
        None => (String::new(), false),
    };

    Ok(GitFileVersions {
        root: root.to_string(),
        path: path.to_string(),
        original,
        modified,
        existed_in_head,
        existed_in_work,
    })
}

/// How deep [`discover_repos`] walks below the selected folder, so a repo nested a few
/// levels down (e.g. `clients/<name>/<repo>`) is still found without scanning the world.
const DISCOVER_MAX_DEPTH: usize = 5;
/// Directories the walk never descends into: build output and dependency trees are both
/// huge and never contain the user's own repos. Dot-directories are skipped separately.
const DISCOVER_SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "vendor", "bin", "obj"];

/// Discover the git repos under a selected folder. If the folder is itself a repo (has a
/// `.git`), it is the only result; otherwise the folder is walked **recursively** (to
/// [`DISCOVER_MAX_DEPTH`], skipping dot- and build/dependency directories, and never
/// descending into a found repo), returned sorted by path. This is what lets the user add
/// a *folder of repos* as a workspace root — however the repos are nested — and still see
/// every repo. A `.git` FILE also counts, so linked worktrees are discovered too.
pub fn discover_repos(root: &str) -> Vec<String> {
    let base = Path::new(root);
    if base.join(".git").exists() {
        return vec![root.to_string()];
    }
    let mut repos = Vec::new();
    walk_for_repos(base, DISCOVER_MAX_DEPTH, &mut repos);
    repos.sort();
    repos
}

fn walk_for_repos(dir: &Path, depth: usize, repos: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Dot-directories are pruned unconditionally — hidden tool clones (`.nvm`,
        // `.oh-my-zsh`, editor caches) are noise even when they ARE git repos.
        if name.starts_with('.') {
            continue;
        }
        // The repo test comes BEFORE the named skip-list, so a real repo that happens
        // to be named `vendor`/`dist`/… is still discovered; the skip-list only prunes
        // what the walk would otherwise descend into.
        if path.join(".git").exists() {
            // A repo bounds the walk: submodules and nested checkouts inside it are its
            // own business, not separate workspace repos.
            repos.push(path.to_string_lossy().to_string());
            continue;
        }
        if DISCOVER_SKIP_DIRS
            .iter()
            .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            continue;
        }
        walk_for_repos(&path, depth - 1, repos);
    }
}

/// The status of every repo discovered under `root` (the multi-repo dashboard). Repos whose
/// status can't be read are skipped rather than failing the whole overview.
pub fn overview(root: &str) -> GitOverview {
    let repos = discover_repos(root)
        .iter()
        .filter_map(|repo| status(repo).ok())
        .collect();
    GitOverview {
        root: root.to_string(),
        repos,
    }
}

/// A repo's local branches plus the checked-out one (for the branch switcher).
pub fn branches(root: &str) -> Result<GitBranches, BridgeError> {
    let listing = run_git(
        root,
        &["branch", "--format=%(refname:short)"],
        "git_branches_failed",
    )?;
    let branches = listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    // A detached HEAD reports literally "HEAD" — treat that as "no current branch".
    let current = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        "git_branches_failed",
    )
    .ok()
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty() && name != "HEAD");
    Ok(GitBranches {
        root: root.to_string(),
        current,
        branches,
    })
}

/// Stage paths (`git add`). Pass `["."]` to stage everything in the repo.
pub fn stage(root: &str, paths: &[String]) -> Result<String, BridgeError> {
    run_git(root, &git_paths_args("add", paths), "git_stage_failed")
}

/// Unstage paths (`git restore --staged`). Pass `["."]` to unstage everything.
pub fn unstage(root: &str, paths: &[String]) -> Result<String, BridgeError> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(root, &args, "git_unstage_failed")
}

/// Commit the staged changes with a message.
pub fn commit(root: &str, message: &str) -> Result<String, BridgeError> {
    run_git(root, &["commit", "-m", message], "git_commit_failed")
}

/// Push the current branch (`git push`). Surfaces git's own message (often on stderr).
pub fn push(root: &str) -> Result<String, BridgeError> {
    run_git(root, &["push"], "git_push_failed")
}

/// Pull fast-forward only (`git pull --ff-only`) — never creates a surprise merge commit.
pub fn pull(root: &str) -> Result<String, BridgeError> {
    run_git(root, &["pull", "--ff-only"], "git_pull_failed")
}

/// Reject a branch/ref name that could be mistaken for a `git` option (a leading `-`) or is
/// otherwise unsafe to pass to a shelled-out `git` (control chars / spaces — never valid in a
/// ref anyway). Refs can't be guarded with `--` the way paths can, so validate before shelling.
fn validate_ref_name(name: &str) -> Result<(), BridgeError> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_control() || c == ' ')
    {
        return Err(BridgeError::new(
            "git_invalid_ref",
            "invalid branch name".to_string(),
        ));
    }
    Ok(())
}

/// Switch to a branch, optionally creating it (`git checkout [-b] <name>`).
pub fn checkout(root: &str, name: &str, create: bool) -> Result<String, BridgeError> {
    validate_ref_name(name)?;
    let args = if create {
        vec!["checkout", "-b", name]
    } else {
        vec!["checkout", name]
    };
    run_git(root, &args, "git_checkout_failed")
}

/// Discard local changes to paths. `untracked` removes untracked files (`git clean -f`);
/// otherwise tracked files are restored to HEAD (`git restore --staged --worktree`).
pub fn discard(root: &str, paths: &[String], untracked: bool) -> Result<String, BridgeError> {
    let args = if untracked {
        git_paths_args_extra("clean", &["-f"], paths)
    } else {
        let mut args = vec!["restore", "--staged", "--worktree", "--"];
        args.extend(paths.iter().map(String::as_str));
        args
    };
    run_git(root, &args, "git_discard_failed")
}

/// Discard **all** local changes: restore every tracked file to HEAD and remove all
/// untracked files + directories. Two steps so both tracked and untracked changes go.
pub fn discard_all(root: &str) -> Result<String, BridgeError> {
    let restored = run_git(
        root,
        &["restore", "--staged", "--worktree", "--", "."],
        "git_discard_failed",
    )?;
    let cleaned = run_git(root, &["clean", "-fd"], "git_discard_failed")?;
    Ok([restored, cleaned]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Delete a local branch (`git branch -d`, or `-D` when `force`). Git refuses `-d` on an
/// unmerged branch unless forced.
pub fn delete_branch(root: &str, name: &str, force: bool) -> Result<String, BridgeError> {
    validate_ref_name(name)?;
    let flag = if force { "-D" } else { "-d" };
    run_git(root, &["branch", flag, name], "git_delete_branch_failed")
}

/// Build `git <verb> -- <paths>` argument list.
fn git_paths_args<'a>(verb: &'a str, paths: &'a [String]) -> Vec<&'a str> {
    let mut args = vec![verb, "--"];
    args.extend(paths.iter().map(String::as_str));
    args
}

/// Build `git <verb> <flags...> -- <paths>` argument list.
fn git_paths_args_extra<'a>(verb: &'a str, flags: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args = vec![verb];
    args.extend_from_slice(flags);
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

/// Run a `git` subcommand in `root`, returning its combined stdout+stderr (trimmed) on
/// success, or a `BridgeError` tagged `fail_code` with git's first error line. (Several git
/// write commands report their useful output on stderr even when they succeed.)
fn run_git(root: &str, args: &[&str], fail_code: &str) -> Result<String, BridgeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| BridgeError::new("git_unavailable", error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(BridgeError::new(
            fail_code,
            first_line(&stderr)
                .unwrap_or("git command failed")
                .to_string(),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut message = stdout.trim().to_string();
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        if !message.is_empty() {
            message.push('\n');
        }
        message.push_str(stderr);
    }
    Ok(message)
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

    #[test]
    fn discover_repos_returns_the_root_when_it_is_a_repo() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir(dir.path().join(".git")).expect("mk .git");
        let root = dir.path().to_string_lossy().to_string();
        assert_eq!(discover_repos(&root), vec![root]);
    }

    #[test]
    fn discover_repos_finds_child_repos_in_a_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in ["alpha", "beta"] {
            std::fs::create_dir_all(dir.path().join(name).join(".git")).expect("mk child repo");
        }
        // A non-repo subdir is ignored.
        std::fs::create_dir(dir.path().join("notarepo")).expect("mk plain dir");
        let repos = discover_repos(&dir.path().to_string_lossy());
        assert_eq!(repos.len(), 2);
        assert!(repos[0].ends_with("alpha"));
        assert!(repos[1].ends_with("beta"));
    }

    #[test]
    fn discover_repos_empty_for_a_plain_folder() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir(dir.path().join("plain")).expect("mk plain dir");
        assert!(discover_repos(&dir.path().to_string_lossy()).is_empty());
    }

    #[test]
    fn discover_repos_walks_nested_folders_but_not_into_repos_or_noise() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Nested two levels down: clients/acme/site is a repo.
        std::fs::create_dir_all(dir.path().join("clients/acme/site/.git")).expect("nested repo");
        // A repo bounds the walk: an embedded checkout inside it is not listed separately.
        std::fs::create_dir_all(dir.path().join("clients/acme/site/embedded/.git"))
            .expect("embedded repo");
        // Dependency/build trees and dot-dirs are never scanned.
        std::fs::create_dir_all(dir.path().join("node_modules/dep/.git")).expect("dep repo");
        std::fs::create_dir_all(dir.path().join(".cache/tool/.git")).expect("dot repo");
        // A linked worktree marker is a `.git` FILE, not a directory.
        std::fs::create_dir_all(dir.path().join("worktrees/feature-x")).expect("worktree dir");
        std::fs::write(
            dir.path().join("worktrees/feature-x/.git"),
            "gitdir: elsewhere",
        )
        .expect("worktree marker");
        // A real repo that happens to carry a skip-list name is still discovered —
        // the repo test runs before the prune.
        std::fs::create_dir_all(dir.path().join("vendor/.git")).expect("repo named vendor");

        let repos = discover_repos(&dir.path().to_string_lossy());
        assert_eq!(repos.len(), 3, "found: {repos:?}");
        assert!(repos.iter().any(|repo| repo.ends_with("site")));
        assert!(repos.iter().any(|repo| repo.ends_with("feature-x")));
        assert!(repos.iter().any(|repo| repo.ends_with("vendor")));
    }
}
