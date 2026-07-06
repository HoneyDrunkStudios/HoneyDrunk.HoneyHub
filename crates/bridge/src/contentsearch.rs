//! Repo-wide **content** search for the cockpit's Repositories surface (PRD-0012 §E) —
//! VS Code's "Find in Files" (Ctrl+Shift+F). Read-posture only: it greps the files under a
//! scope the host has already gated against the ADR-0090 workspace allowlist (exactly like the
//! [`crate::fsbrowse`] file read), returns line-level matches, and never edits or executes.
//!
//! Two engines, chosen at call time and reported honestly in [`ContentSearchResults::engine`]:
//! - **ripgrep** (`rg`) when it is on `PATH` — fast, respects `.gitignore`, skips binaries.
//! - a **Rust walk+read fallback** when `rg` is absent — skips the same noise directories, skips
//!   binary files (NUL byte / non-UTF-8), and does literal (optionally case-sensitive / whole-word)
//!   matching. Regex is a ripgrep-only capability; a regex query with no `rg` present surfaces an
//!   honest `regex_unavailable` error rather than silently matching literally.
//!
//! Results are **capped** ([`MAX_CONTENT_MATCHES`] matches / [`MAX_CONTENT_FILES`] files) and the
//! response flags [`ContentSearchResults::truncated`] when a cap was hit — matches are never
//! silently dropped without saying so. Spawning `rg` is a one-shot, non-interactive read of the
//! same allowlisted roots `read_file` already exposes; it adds no exec exception and stays within
//! the ADR-0090 read posture (it is not one of the ADR-0096 named-action exec surfaces).

use crate::adapter::BridgeError;
use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

/// Cap on total matches returned in one response. Beyond this the walk stops and the
/// response is flagged `truncated` so the UI can say "showing the first N".
pub const MAX_CONTENT_MATCHES: usize = 500;
/// Cap on distinct files returned in one response (a second truncation axis, so a query that
/// hits a match in thousands of files still returns promptly).
pub const MAX_CONTENT_FILES: usize = 50;
/// Longest single matched line returned (a display cap — the file on disk is unchanged). A
/// pathological minified line cannot flood the wire.
const MAX_LINE_TEXT_CHARS: usize = 500;
/// Largest file the **fallback** reads+scans. Bigger files are skipped (rg makes its own call).
const MAX_FALLBACK_FILE_BYTES: u64 = 5_242_880; // 5 MiB
/// Cap on directories the fallback walk visits, so a huge tree can never hang it.
const MAX_FALLBACK_DIRS: usize = 60_000;

/// Directory names skipped by both engines — the heavy/generated trees from the host's
/// `FS_IGNORED_DIRS` (`.git`, `node_modules`, `target`, `dist`). rg also honors `.gitignore`.
const CONTENT_SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist"];

/// Environment override for the ripgrep program name/path (mirrors the adapters'
/// `HONEYHUB_*_PROGRAM` overrides). Set it empty to force the pure-Rust fallback.
const RG_PROGRAM_ENV: &str = "HONEYHUB_RG_PROGRAM";

/// Which engine produced a result set (surfaced so the UI can be honest about capability —
/// e.g. regex is ripgrep-only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentSearchEngine {
    Ripgrep,
    Fallback,
}

/// One content match: a file, a 1-based line, an optional 1-based column of the match start, and
/// the matched line's text (trimmed of the trailing newline, capped at [`MAX_LINE_TEXT_CHARS`]).
/// One row per matching line (matching ripgrep's default), keyed off the first hit on the line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    /// The file's absolute path.
    pub path: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column of the match start (character offset), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    /// The matched line's text.
    pub line_text: String,
}

/// The result of a content search: the flat match list (the UI groups by `path`), the number of
/// distinct files, whether a cap truncated the walk, and which engine ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResults {
    /// The scope the search ran under (an allowlisted folder).
    pub root: String,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
    pub matches: Vec<ContentMatch>,
    /// The number of distinct files in `matches`.
    pub file_count: u32,
    /// True when [`MAX_CONTENT_MATCHES`] or [`MAX_CONTENT_FILES`] was reached before the walk
    /// finished (some matches were not returned).
    pub truncated: bool,
    /// Which engine produced this result (ripgrep vs the Rust fallback).
    pub engine: ContentSearchEngine,
}

/// The search flags (all default to off — a plain, case-insensitive, substring search).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContentSearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
}

/// Search the tree under `root` for `query`, preferring ripgrep and falling back to a pure-Rust
/// walk when `rg` is absent. `root` must be a directory (the host gates it against the workspace
/// allowlist first). An empty/whitespace query returns no matches. See the module docs for the
/// engine/cap/truncation contract.
pub fn search_content(
    root: &str,
    query: &str,
    options: ContentSearchOptions,
) -> Result<ContentSearchResults, BridgeError> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(BridgeError::new(
            "not_a_directory",
            format!("{root} is not a directory"),
        ));
    }

    let rg = ripgrep_program();
    let trimmed = query.trim();
    if trimmed.is_empty() {
        // Nothing to search; report the engine we *would* use so the UI stays honest.
        return Ok(empty_results(
            root,
            query,
            options,
            if rg.is_some() {
                ContentSearchEngine::Ripgrep
            } else {
                ContentSearchEngine::Fallback
            },
        ));
    }

    match rg {
        Some(program) => search_with_ripgrep(&program, root, query, options),
        None => search_with_fallback(root, query, options),
    }
}

/// The ripgrep program to run, or `None` to use the fallback. Honors [`RG_PROGRAM_ENV`]: unset
/// defaults to `rg`; set-empty forces the fallback; otherwise the given name/path is resolved on
/// `PATH` (same resolution the adapters use).
fn ripgrep_program() -> Option<String> {
    let name = std::env::var(RG_PROGRAM_ENV).unwrap_or_else(|_| "rg".to_string());
    if name.trim().is_empty() {
        return None;
    }
    resolve_program(&name).map(|_| name)
}

fn empty_results(
    root: &str,
    query: &str,
    options: ContentSearchOptions,
    engine: ContentSearchEngine,
) -> ContentSearchResults {
    ContentSearchResults {
        root: root.to_string(),
        query: query.to_string(),
        case_sensitive: options.case_sensitive,
        whole_word: options.whole_word,
        is_regex: options.is_regex,
        matches: Vec::new(),
        file_count: 0,
        truncated: false,
        engine,
    }
}

/// Run ripgrep with `--json` and fold its match stream into [`ContentSearchResults`], stopping
/// (and flagging `truncated`) once a cap is hit. rg respects `.gitignore` and skips binaries; the
/// explicit `-g !<dir>` globs also drop the noise directories in repos that don't gitignore them.
fn search_with_ripgrep(
    program: &str,
    root: &str,
    query: &str,
    options: ContentSearchOptions,
) -> Result<ContentSearchResults, BridgeError> {
    let mut args: Vec<String> = vec!["--json".to_string(), "--no-messages".to_string()];
    if !options.case_sensitive {
        args.push("--ignore-case".to_string());
    }
    if options.whole_word {
        args.push("--word-regexp".to_string());
    }
    if !options.is_regex {
        args.push("--fixed-strings".to_string());
    }
    for dir in CONTENT_SKIP_DIRS {
        args.push("--glob".to_string());
        args.push(format!("!{dir}"));
    }
    // `-e` guards a pattern that begins with `-`; the root is the final positional path.
    args.push("--regexp".to_string());
    args.push(query.to_string());
    args.push(root.to_string());

    let mut child = Command::new(program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| BridgeError::new("search_spawn_failed", error.to_string()))?;

    let stdout = child.stdout.take().ok_or_else(|| {
        BridgeError::new("search_spawn_failed", "ripgrep produced no stdout pipe")
    })?;
    // Drain stderr on its own thread (capped) so an error message is available for an
    // explicit failure report instead of vanishing into an empty result set.
    let stderr_reader = child.stderr.take().map(|stderr| {
        std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = BufReader::new(stderr)
                .take(4096)
                .read_to_string(&mut buffer);
            buffer
        })
    });

    let mut acc = MatchAccumulator::new();
    let mut capped = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(m) = parse_ripgrep_match(&line) {
            if acc.push(m) {
                capped = true;
                break;
            }
        }
    }
    if capped {
        // We stopped rg mid-stream, so its exit status is not meaningful; make sure the
        // child is not left running and return what was accumulated (flagged truncated).
        let _ = child.kill();
        let _ = child.wait();
        if let Some(reader) = stderr_reader {
            let _ = reader.join();
        }
        return Ok(acc.finish(root, query, options, ContentSearchEngine::Ripgrep));
    }

    // The stream ended on rg's own terms, so its exit status is meaningful: 0 = matches,
    // 1 = no matches, anything else (e.g. 2: invalid regex, unreadable root) is a real
    // failure that must surface as an explicit error, never as silently-empty results.
    let status = child.wait();
    let stderr_text = stderr_reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    match status {
        Ok(status) if status.success() || status.code() == Some(1) => {
            Ok(acc.finish(root, query, options, ContentSearchEngine::Ripgrep))
        }
        Ok(status) => Err(BridgeError::new(
            "search_failed",
            format!(
                "ripgrep exited with {status}: {}",
                summarize_stderr(&stderr_text)
            ),
        )),
        Err(error) => Err(BridgeError::new("search_failed", error.to_string())),
    }
}

/// First non-empty stderr line (ripgrep's error message), or a placeholder.
fn summarize_stderr(stderr: &str) -> &str {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("(no error output)")
}

/// Parse one ripgrep `--json` line into a [`ContentMatch`], or `None` for non-match records
/// (`begin`/`end`/`summary`) and lines whose text isn't valid UTF-8 (rg emits `bytes` instead).
fn parse_ripgrep_match(line: &str) -> Option<ContentMatch> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "match" {
        return None;
    }
    let data = value.get("data")?;
    let path = data.get("path")?.get("text")?.as_str()?.to_string();
    let line_number = data.get("line_number")?.as_u64()? as u32;
    let line_text_full = data.get("lines")?.get("text")?.as_str()?;
    // The first submatch gives the match start as a byte offset within the line.
    let start_byte = data
        .get("submatches")
        .and_then(|s| s.as_array())
        .and_then(|s| s.first())
        .and_then(|s| s.get("start"))
        .and_then(|s| s.as_u64())
        .map(|start| start as usize);
    let column = start_byte.map(|byte| byte_to_column(line_text_full, byte));
    Some(ContentMatch {
        path,
        line: line_number,
        column,
        line_text: clip_line(line_text_full),
    })
}

/// Walk the tree under `root` in Rust, scanning each text file line-by-line. Skips the noise
/// directories, skips binary/oversized files, and stops (flagging `truncated`) once a cap is hit.
/// Regex is ripgrep-only, so a regex query here is an honest `regex_unavailable` error.
fn search_with_fallback(
    root: &str,
    query: &str,
    options: ContentSearchOptions,
) -> Result<ContentSearchResults, BridgeError> {
    if options.is_regex {
        return Err(BridgeError::new(
            "regex_unavailable",
            "regex search needs ripgrep (rg) on PATH; it was not found",
        ));
    }
    let needle = query.trim();
    let mut acc = MatchAccumulator::new();
    let mut stack = vec![Path::new(root).to_path_buf()];
    let mut visited = 0usize;
    'walk: while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > MAX_FALLBACK_DIRS {
            acc.truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        // Sort a directory's entries for a stable, predictable match order.
        let mut subdirs = Vec::new();
        let mut files = Vec::new();
        for item in read.flatten() {
            let Ok(file_type) = item.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let name = item.file_name().to_string_lossy().to_string();
                if !CONTENT_SKIP_DIRS.contains(&name.as_str()) {
                    subdirs.push(item.path());
                }
            } else if file_type.is_file() {
                files.push(item.path());
            }
        }
        files.sort();
        subdirs.sort();
        for file in files {
            if scan_file_fallback(&file, needle, options, &mut acc) {
                break 'walk; // a cap was hit
            }
        }
        // Push in reverse so the sorted order is preserved by the LIFO stack.
        for subdir in subdirs.into_iter().rev() {
            stack.push(subdir);
        }
    }
    Ok(acc.finish(root, query, options, ContentSearchEngine::Fallback))
}

/// Scan one file for `needle`, appending one match per matching line. Skips oversized and binary
/// (NUL byte / non-UTF-8) files. Returns `true` when a cap was hit and the walk must stop.
fn scan_file_fallback(
    file: &Path,
    needle: &str,
    options: ContentSearchOptions,
    acc: &mut MatchAccumulator,
) -> bool {
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    if metadata.len() > MAX_FALLBACK_FILE_BYTES {
        return false;
    }
    let Ok(raw) = std::fs::read(file) else {
        return false;
    };
    if raw.contains(&0) {
        return false; // binary
    }
    let Ok(text) = std::str::from_utf8(&raw) else {
        return false; // not UTF-8 text
    };
    let path = file.to_string_lossy().to_string();
    for (index, line) in text.lines().enumerate() {
        if let Some(column) = first_line_match(line, needle, options) {
            let matched = ContentMatch {
                path: path.clone(),
                line: (index + 1) as u32,
                column: Some(column),
                line_text: clip_line(line),
            };
            if acc.push(matched) {
                return true;
            }
        }
    }
    false
}

/// The 1-based character column of the first `needle` occurrence in `line` (honoring
/// case-sensitivity and whole-word), or `None` when the line does not match.
fn first_line_match(line: &str, needle: &str, options: ContentSearchOptions) -> Option<u32> {
    let (hay, ndl): (Cow<str>, Cow<str>) = if options.case_sensitive {
        (Cow::Borrowed(line), Cow::Borrowed(needle))
    } else {
        (
            Cow::Owned(line.to_lowercase()),
            Cow::Owned(needle.to_lowercase()),
        )
    };
    if ndl.is_empty() {
        return None;
    }
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(ndl.as_ref()) {
        let start = from + rel;
        let end = start + ndl.len();
        if !options.whole_word || is_word_boundary(&hay, start, end) {
            return Some((hay[..start].chars().count() + 1) as u32);
        }
        // Advance one character past this candidate and keep looking on the same line.
        from = start + hay[start..].chars().next().map_or(1, char::len_utf8);
        if from >= hay.len() {
            break;
        }
    }
    None
}

/// True when the byte range `[start, end)` in `text` is bounded by non-word characters (a
/// whole-word match). Word characters are alphanumerics and `_`.
fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let before_ok = text[..start]
        .chars()
        .next_back()
        .is_none_or(|c| !is_word_char(c));
    let after_ok = text[end..].chars().next().is_none_or(|c| !is_word_char(c));
    before_ok && after_ok
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The 1-based character column for a byte offset within `line` (counts characters, so it is
/// correct for multi-byte UTF-8). An out-of-range/non-boundary offset clamps to the line length.
fn byte_to_column(line: &str, byte: usize) -> u32 {
    let prefix = if byte <= line.len() && line.is_char_boundary(byte) {
        &line[..byte]
    } else {
        line
    };
    (prefix.chars().count() + 1) as u32
}

/// Strip a trailing `\r\n`/`\n` and cap the line at [`MAX_LINE_TEXT_CHARS`] characters.
fn clip_line(line: &str) -> String {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.chars().count() <= MAX_LINE_TEXT_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_LINE_TEXT_CHARS).collect()
}

/// Accumulates matches while enforcing the two caps. `push` returns `true` once a cap is reached
/// so the caller stops the (streamed or walked) scan.
struct MatchAccumulator {
    matches: Vec<ContentMatch>,
    files: Vec<String>,
    truncated: bool,
}

impl MatchAccumulator {
    fn new() -> Self {
        Self {
            matches: Vec::new(),
            files: Vec::new(),
            truncated: false,
        }
    }

    /// Record a match, or signal a stop. Returns `true` when a cap is hit (the match is not
    /// recorded and `truncated` is set) so the scan can end promptly.
    fn push(&mut self, matched: ContentMatch) -> bool {
        let is_new_file = self.files.last().map(String::as_str) != Some(matched.path.as_str())
            && !self.files.iter().any(|path| path == &matched.path);
        if is_new_file && self.files.len() >= MAX_CONTENT_FILES {
            self.truncated = true;
            return true;
        }
        if self.matches.len() >= MAX_CONTENT_MATCHES {
            self.truncated = true;
            return true;
        }
        if is_new_file {
            self.files.push(matched.path.clone());
        }
        self.matches.push(matched);
        false
    }

    fn finish(
        self,
        root: &str,
        query: &str,
        options: ContentSearchOptions,
        engine: ContentSearchEngine,
    ) -> ContentSearchResults {
        ContentSearchResults {
            root: root.to_string(),
            query: query.to_string(),
            case_sensitive: options.case_sensitive,
            whole_word: options.whole_word,
            is_regex: options.is_regex,
            file_count: self.files.len() as u32,
            matches: self.matches,
            truncated: self.truncated,
            engine,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::WorkspaceAllowlist;
    use std::fs;

    fn opts() -> ContentSearchOptions {
        ContentSearchOptions::default()
    }

    #[test]
    fn fallback_finds_matches_grouped_and_reports_line_and_column() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("a.rs"),
            b"fn main() {\n    let needle = 1;\n    other();\n}\n",
        )
        .unwrap();

        let results = search_with_fallback(dir.path().to_str().unwrap(), "needle", opts()).unwrap();
        assert_eq!(results.engine, ContentSearchEngine::Fallback);
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.file_count, 1);
        let hit = &results.matches[0];
        assert_eq!(hit.line, 2);
        assert_eq!(hit.column, Some(9)); // 4 spaces + "let " = column 9
        assert_eq!(hit.line_text, "    let needle = 1;");
        assert!(!results.truncated);
    }

    #[test]
    fn fallback_is_case_insensitive_by_default_and_case_sensitive_on_request() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"Alpha\nalpha\nALPHA\n").unwrap();

        let insensitive =
            search_with_fallback(dir.path().to_str().unwrap(), "alpha", opts()).unwrap();
        assert_eq!(insensitive.matches.len(), 3);

        let sensitive = search_with_fallback(
            dir.path().to_str().unwrap(),
            "alpha",
            ContentSearchOptions {
                case_sensitive: true,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(sensitive.matches.len(), 1);
        assert_eq!(sensitive.matches[0].line, 2);
    }

    #[test]
    fn fallback_whole_word_excludes_substring_hits() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"cat\ncategory\nthe cat sat\n").unwrap();

        let whole = search_with_fallback(
            dir.path().to_str().unwrap(),
            "cat",
            ContentSearchOptions {
                whole_word: true,
                ..opts()
            },
        )
        .unwrap();
        let lines: Vec<u32> = whole.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![1, 3]); // "category" (line 2) is not a whole word
    }

    #[test]
    fn fallback_skips_ignored_dirs_and_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("keep.txt"), b"target token here\n").unwrap();
        // A skipped heavy dir whose file must NOT show up.
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(
            dir.path().join("node_modules").join("dep.js"),
            b"token in node_modules\n",
        )
        .unwrap();
        // A binary file (NUL byte) is skipped even though it contains the needle bytes.
        fs::write(dir.path().join("blob.bin"), b"token\x00binary\n").unwrap();

        let results = search_with_fallback(dir.path().to_str().unwrap(), "token", opts()).unwrap();
        assert_eq!(results.matches.len(), 1);
        assert!(results.matches[0].path.ends_with("keep.txt"));
    }

    #[test]
    fn fallback_caps_matches_and_flags_truncation() {
        let dir = tempfile::tempdir().unwrap();
        // One file with far more matching lines than the cap.
        let body = "hit\n".repeat(MAX_CONTENT_MATCHES + 25);
        fs::write(dir.path().join("many.txt"), body).unwrap();

        let results = search_with_fallback(dir.path().to_str().unwrap(), "hit", opts()).unwrap();
        assert_eq!(results.matches.len(), MAX_CONTENT_MATCHES);
        assert!(results.truncated);
    }

    #[test]
    fn empty_query_returns_no_matches() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"anything\n").unwrap();
        let results = search_content(dir.path().to_str().unwrap(), "   ", opts()).unwrap();
        assert!(results.matches.is_empty());
        assert!(!results.truncated);
    }

    #[test]
    fn regex_without_ripgrep_is_an_honest_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"abc123\n").unwrap();
        let error = search_with_fallback(
            dir.path().to_str().unwrap(),
            r"\d+",
            ContentSearchOptions {
                is_regex: true,
                ..opts()
            },
        )
        .expect_err("regex needs rg");
        assert_eq!(error.code, "regex_unavailable");
    }

    #[test]
    fn public_search_finds_a_match_on_whichever_engine_is_present() {
        // Exercises the public dispatcher end-to-end: ripgrep when `rg` is on PATH (validating the
        // `--json` parser), the Rust fallback otherwise. Either way the match is found and the
        // engine is reported honestly.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("lib.rs"),
            b"fn one() {}\nfn find_me() {}\nfn three() {}\n",
        )
        .unwrap();

        let results = search_content(dir.path().to_str().unwrap(), "find_me", opts()).unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 2);
        assert!(results.matches[0].path.ends_with("lib.rs"));
        assert_eq!(results.file_count, 1);
        assert!(matches!(
            results.engine,
            ContentSearchEngine::Ripgrep | ContentSearchEngine::Fallback
        ));
    }

    #[test]
    fn an_invalid_regex_is_an_explicit_error_on_either_engine() {
        // With rg present, an unbalanced paren makes rg exit 2 and must surface as
        // `search_failed` (with rg's stderr message), never as silently-empty results;
        // without rg, regex is `regex_unavailable`. Either way: an error, not `Ok(empty)`.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), b"abc\n").unwrap();
        let error = search_content(
            dir.path().to_str().unwrap(),
            "(",
            ContentSearchOptions {
                is_regex: true,
                ..opts()
            },
        )
        .expect_err("invalid regex must error");
        assert!(matches!(
            error.code.as_str(),
            "search_failed" | "regex_unavailable"
        ));
    }

    #[test]
    fn non_directory_root_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.txt");
        fs::write(&file, b"x").unwrap();
        let error = search_content(file.to_str().unwrap(), "x", opts()).expect_err("not a dir");
        assert_eq!(error.code, "not_a_directory");
    }

    #[test]
    fn allowlist_denies_a_scope_outside_an_added_root() {
        // The host gates a search scope with exactly this `allows` check (see bridge-host's
        // `SearchContent` arm). A sibling directory outside the added root must be denied, while
        // the root itself (and a child of it) is allowed. `allows` canonicalizes, so `..`/symlink
        // escapes resolve out of the root and fail the `starts_with`.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let child = root.path().join("src");
        fs::create_dir(&child).unwrap();

        let allowlist = WorkspaceAllowlist::new(vec![root.path().to_string_lossy().to_string()]);
        assert!(allowlist.allows(root.path().to_str().unwrap()));
        assert!(allowlist.allows(child.to_str().unwrap()));
        assert!(!allowlist.allows(outside.path().to_str().unwrap()));
    }
}
