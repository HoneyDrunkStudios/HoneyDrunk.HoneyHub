//! Read-only filesystem browsing for the cockpit's repo/file viewer (packet 09 §3).
//!
//! The webview cannot read the local disk, so the bridge exposes two read-only
//! operations:
//! - [`browse_dir`] — directory **navigation** (names + kinds only, no contents).
//!   Unscoped, so the first-run folder picker can find where the user's repos live.
//!   It is the user's own machine reached through their own paired cockpit, and it
//!   never returns file *contents* — only entry names.
//! - [`read_file`] — file **contents** as UTF-8 text. The caller (the host) gates
//!   this against the workspace allowlist, so contents only ever come from a root
//!   the user explicitly added. Binary files and oversized files are refused, never
//!   fabricated or truncated silently without saying so.

use crate::adapter::BridgeError;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Largest file the viewer will fetch. Content past this is dropped and the
/// response is flagged `truncated` so the UI can say so honestly.
pub const MAX_FILE_BYTES: u64 = 1_048_576; // 1 MiB

/// Cap on directory entries returned in one listing, so an enormous folder cannot
/// flood the wire. The UI shows the count; refinement (paging) is a follow-up.
pub const MAX_DIR_ENTRIES: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirEntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: DirEntryKind,
    /// Size in bytes for files (omitted for directories).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// The absolute directory listed. Empty string means the synthetic top level
    /// (drive letters on Windows, `/` on Unix).
    pub path: String,
    /// The parent directory to navigate up to, if any (none at a drive/root).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// True when the directory had more than [`MAX_DIR_ENTRIES`] entries.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: String,
    pub content: String,
    /// True when the file exceeded [`MAX_FILE_BYTES`] and `content` is a prefix.
    pub truncated: bool,
    /// The file's full size in bytes (even when truncated).
    pub byte_size: u64,
}

/// A filename-search match (the viewer's in-repo search).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub root: String,
    pub query: String,
    pub hits: Vec<SearchHit>,
    /// True when the result cap (or the visited-dir cap) was hit before exhausting.
    pub truncated: bool,
}

/// Cap on search hits returned in one response.
pub const MAX_SEARCH_HITS: usize = 300;
/// Cap on directories visited per search, so a huge tree can't hang the walk.
pub const MAX_SEARCH_DIRS: usize = 60_000;

/// Directory names skipped during search — heavy/generated trees that would slow the
/// walk and rarely hold files the user is looking for.
const SEARCH_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".turbo",
    "bin",
    "obj",
];

/// List a directory's immediate children (names + kinds only). With no path (or an
/// empty one), returns the synthetic top level: drive roots on Windows, `/` on Unix.
pub fn browse_dir(path: Option<&str>) -> Result<DirListing, BridgeError> {
    let trimmed = path.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return Ok(top_level());
    }

    let dir = Path::new(trimmed);
    if !dir.is_dir() {
        return Err(BridgeError::new(
            "not_a_directory",
            format!("{trimmed} is not a directory"),
        ));
    }

    let read = std::fs::read_dir(dir)
        .map_err(|error| BridgeError::new("read_dir_failed", error.to_string()))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for item in read {
        let Ok(item) = item else { continue };
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            entries.push(DirEntry {
                name,
                kind: DirEntryKind::Dir,
                size: None,
            });
        } else if file_type.is_file() {
            let size = item.metadata().ok().map(|meta| meta.len());
            entries.push(DirEntry {
                name,
                kind: DirEntryKind::File,
                size,
            });
        }
        // Symlinks/other types are skipped (read-only browse of plain files/dirs).
    }

    // Directories first, then files, each case-insensitively by name — a stable,
    // predictable order for the tree.
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        (DirEntryKind::Dir, DirEntryKind::File) => std::cmp::Ordering::Less,
        (DirEntryKind::File, DirEntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let normalized = dir
        .canonicalize()
        .map(|p| strip_unc(&p))
        .unwrap_or_else(|_| trimmed.to_string());
    let parent = Path::new(&normalized)
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    Ok(DirListing {
        path: normalized,
        parent,
        entries,
        truncated,
    })
}

/// Read a file as UTF-8 text. Refuses non-files, binary content, and reads at most
/// [`MAX_FILE_BYTES`] (flagging `truncated`). The host gates the path against the
/// workspace allowlist before calling this.
pub fn read_file(path: &str) -> Result<FileContents, BridgeError> {
    let file = Path::new(path);
    let metadata = file
        .metadata()
        .map_err(|error| BridgeError::new("file_not_found", error.to_string()))?;
    if !metadata.is_file() {
        return Err(BridgeError::new(
            "not_a_file",
            format!("{path} is not a file"),
        ));
    }

    let byte_size = metadata.len();
    let raw = std::fs::read(file)
        .map_err(|error| BridgeError::new("read_file_failed", error.to_string()))?;

    let truncated = raw.len() as u64 > MAX_FILE_BYTES;
    let slice = if truncated {
        &raw[..MAX_FILE_BYTES as usize]
    } else {
        &raw[..]
    };

    // Binary detection: a NUL byte (or non-UTF-8 once not truncated) means it is not
    // a text file we should try to display.
    if slice.contains(&0) {
        return Err(BridgeError::new(
            "binary_file",
            "file appears to be binary and cannot be displayed",
        ));
    }
    let content = match std::str::from_utf8(slice) {
        Ok(text) => text.to_string(),
        Err(error) if truncated => {
            // A multi-byte char may straddle the cut; keep the valid prefix.
            String::from_utf8_lossy(&slice[..error.valid_up_to()]).to_string()
        }
        Err(_) => {
            return Err(BridgeError::new(
                "binary_file",
                "file is not valid UTF-8 text and cannot be displayed",
            ));
        }
    };

    Ok(FileContents {
        path: file
            .canonicalize()
            .map(|p| strip_unc(&p))
            .unwrap_or_else(|_| path.to_string()),
        content,
        truncated,
        byte_size,
    })
}

/// The outcome of a host-owned file write (the in-app editor's Save), surfaced to the
/// UI as feedback. A failed write reports as `ok: false` with the io error in `message`
/// rather than as a transport error, mirroring [`crate::git::GitOpResult`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Write `content` to `path` as the file's full new contents (overwrites if it exists,
/// creates it if new). The caller (the host) gates `path` against the workspace
/// allowlist before calling, so writes only ever land inside a root the user explicitly
/// added. Reports the io outcome as a [`FileWriteResult`] — a failed write is `ok: false`
/// with the io error string in `message`, never a fabricated success.
pub fn write_file(path: &str, content: &str) -> FileWriteResult {
    match std::fs::write(Path::new(path), content.as_bytes()) {
        Ok(()) => {
            let resolved = Path::new(path)
                .canonicalize()
                .map(|p| strip_unc(&p))
                .unwrap_or_else(|_| path.to_string());
            FileWriteResult {
                path: resolved,
                ok: true,
                message: None,
            }
        }
        Err(error) => FileWriteResult {
            path: path.to_string(),
            ok: false,
            message: Some(error.to_string()),
        },
    }
}

/// The repo folders a VS Code `.code-workspace` file points at, resolved to absolute
/// directory paths (the picker can add several repos from one file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolders {
    /// The `.code-workspace` file that was resolved.
    pub workspace_file: String,
    /// Absolute paths of the existing directories it references.
    pub folders: Vec<String>,
}

/// Whether a filename is a VS Code multi-root workspace file.
pub fn is_workspace_file(name: &str) -> bool {
    name.to_lowercase().ends_with(".code-workspace")
}

/// Resolve a `.code-workspace` file to the absolute repo directories it references.
/// Folder paths are resolved relative to the workspace file's own directory; only
/// existing directories are returned. JSONC (comments / trailing commas) is tolerated.
pub fn resolve_workspace_file(path: &str) -> Result<WorkspaceFolders, BridgeError> {
    let file = Path::new(path);
    if !file.is_file() {
        return Err(BridgeError::new(
            "not_a_file",
            format!("{path} is not a file"),
        ));
    }
    let raw = std::fs::read_to_string(file)
        .map_err(|error| BridgeError::new("read_file_failed", error.to_string()))?;
    let value: serde_json::Value = serde_json::from_str(&strip_jsonc(&raw))
        .map_err(|error| BridgeError::new("bad_workspace_file", error.to_string()))?;

    let base = file.parent().unwrap_or_else(|| Path::new("."));
    let mut folders = Vec::new();
    if let Some(list) = value.get("folders").and_then(|f| f.as_array()) {
        for entry in list {
            let Some(rel) = entry.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            let candidate = {
                let p = Path::new(rel);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    base.join(p)
                }
            };
            if candidate.is_dir() {
                let resolved = candidate
                    .canonicalize()
                    .map(|p| strip_unc(&p))
                    .unwrap_or_else(|_| candidate.to_string_lossy().to_string());
                if !folders.contains(&resolved) {
                    folders.push(resolved);
                }
            }
        }
    }

    Ok(WorkspaceFolders {
        workspace_file: file
            .canonicalize()
            .map(|p| strip_unc(&p))
            .unwrap_or_else(|_| path.to_string()),
        folders,
    })
}

/// Strip JSONC extras (line/block comments + trailing commas) so a `.code-workspace`
/// with comments still parses as JSON. String contents are preserved.
fn strip_jsonc(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            i = copy_json_string(bytes, i, &mut out);
        } else if is_two_byte(bytes, i, b'/') {
            // Skip a `//` line comment up to (but not including) the newline.
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if is_two_byte(bytes, i, b'*') {
            // Skip a `/* ... */` block comment.
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    // Drop trailing commas before } or ].
    strip_trailing_commas(&out)
}

/// True when `bytes[i]` opens a `/`-prefixed pair whose second byte is `second`
/// (i.e. `//` for `second == b'/'`, `/*` for `second == b'*'`).
fn is_two_byte(bytes: &[u8], i: usize, second: u8) -> bool {
    bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == second
}

/// Copy a JSON string literal beginning at the opening quote `bytes[start]`,
/// honoring backslash escapes, into `out`. Returns the index past the closing quote.
fn copy_json_string(bytes: &[u8], start: usize, out: &mut String) -> usize {
    out.push('"');
    let mut i = start + 1;
    let mut escaped = false;
    while i < bytes.len() {
        let c = bytes[i];
        out.push(c as char);
        i += 1;
        if escaped {
            escaped = false;
        } else if c == b'\\' {
            escaped = true;
        } else if c == b'"' {
            break;
        }
    }
    i
}

/// Remove commas that immediately precede a `}` or `]` (ignoring whitespace), which
/// JSON forbids but JSONC allows.
fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1; // skip the comma
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Recursively search a directory tree for files whose name contains `query`
/// (case-insensitive). Skips heavy/generated directories, and is bounded by
/// [`MAX_SEARCH_HITS`] + [`MAX_SEARCH_DIRS`] so it always returns promptly. The host
/// gates `root` against the workspace allowlist before calling this.
pub fn search_files(root: &str, query: &str) -> Result<SearchResults, BridgeError> {
    let needle = query.trim().to_lowercase();
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(BridgeError::new(
            "not_a_directory",
            format!("{root} is not a directory"),
        ));
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    if needle.is_empty() {
        return Ok(SearchResults {
            root: root.to_string(),
            query: query.to_string(),
            hits,
            truncated,
        });
    }

    let mut stack = vec![root_path.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > MAX_SEARCH_DIRS {
            truncated = true;
            break;
        }
        if scan_dir(&dir, &needle, &mut hits, &mut stack) {
            truncated = true;
            break;
        }
    }

    hits.sort_by_key(|hit| hit.name.to_lowercase());
    Ok(SearchResults {
        root: root.to_string(),
        query: query.to_string(),
        hits,
        truncated,
    })
}

/// Scan one directory: push matching files onto `hits` and child directories
/// (minus skipped ones) onto `stack`. Returns `true` once [`MAX_SEARCH_HITS`] is
/// reached so the caller can stop and mark the results truncated.
fn scan_dir(
    dir: &Path,
    needle: &str,
    hits: &mut Vec<SearchHit>,
    stack: &mut Vec<std::path::PathBuf>,
) -> bool {
    let Ok(read) = std::fs::read_dir(dir) else {
        return false;
    };
    for item in read.flatten() {
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                stack.push(item.path());
            }
        } else if file_type.is_file() && name.to_lowercase().contains(needle) {
            if hits.len() >= MAX_SEARCH_HITS {
                return true;
            }
            hits.push(SearchHit {
                path: item.path().to_string_lossy().to_string(),
                name,
            });
        }
    }
    false
}

/// The synthetic top level for the picker: existing drive roots on Windows, `/`
/// elsewhere. `path` is empty (the sentinel for "top"), with no parent.
fn top_level() -> DirListing {
    let entries = if cfg!(windows) {
        ('A'..='Z')
            .map(|letter| format!("{letter}:\\"))
            .filter(|drive| Path::new(drive).is_dir())
            .map(|drive| DirEntry {
                name: drive,
                kind: DirEntryKind::Dir,
                size: None,
            })
            .collect()
    } else {
        vec![DirEntry {
            name: "/".to_string(),
            kind: DirEntryKind::Dir,
            size: None,
        }]
    };
    DirListing {
        path: String::new(),
        parent: None,
        entries,
        truncated: false,
    }
}

/// Strip the Windows `\\?\` extended-length prefix that `canonicalize` adds, so the
/// paths the UI shows (and sends back) stay the familiar `C:\…` form.
fn strip_unc(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn browse_lists_dirs_first_then_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir(dir.path().join("zzz_dir")).unwrap();
        fs::write(dir.path().join("aaa.txt"), b"hi").unwrap();
        fs::write(dir.path().join("readme.md"), b"# hi").unwrap();

        let listing = browse_dir(Some(dir.path().to_str().unwrap())).expect("listing");
        assert_eq!(listing.entries[0].kind, DirEntryKind::Dir);
        assert_eq!(listing.entries[0].name, "zzz_dir");
        // Files follow, alphabetical.
        let files: Vec<&str> = listing
            .entries
            .iter()
            .filter(|e| e.kind == DirEntryKind::File)
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(files, vec!["aaa.txt", "readme.md"]);
        assert!(listing.parent.is_some());
    }

    #[test]
    fn empty_path_returns_top_level_roots() {
        let listing = browse_dir(None).expect("top level");
        assert_eq!(listing.path, "");
        assert!(listing.parent.is_none());
        assert!(!listing.entries.is_empty());
        assert!(listing.entries.iter().all(|e| e.kind == DirEntryKind::Dir));
    }

    #[test]
    fn browse_rejects_a_file_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.txt");
        fs::write(&file, b"x").unwrap();
        let error = browse_dir(Some(file.to_str().unwrap())).expect_err("not a dir");
        assert_eq!(error.code, "not_a_directory");
    }

    #[test]
    fn reads_a_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hello.rs");
        fs::write(&file, b"fn main() {}\n").unwrap();
        let contents = read_file(file.to_str().unwrap()).expect("read");
        assert_eq!(contents.content, "fn main() {}\n");
        assert!(!contents.truncated);
        assert_eq!(contents.byte_size, 13);
    }

    #[test]
    fn refuses_a_binary_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("blob.bin");
        fs::write(&file, [0u8, 1, 2, 3, 0]).unwrap();
        let error = read_file(file.to_str().unwrap()).expect_err("binary");
        assert_eq!(error.code, "binary_file");
    }

    #[test]
    fn read_missing_file_errors() {
        let error = read_file("definitely-not-a-real-file-xyz.txt").expect_err("missing");
        assert_eq!(error.code, "file_not_found");
    }

    #[test]
    fn write_file_creates_and_overwrites_reporting_the_resolved_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.txt");

        // A new file: ok, no message, and the contents land on disk.
        let created = write_file(file.to_str().unwrap(), "first\n");
        assert!(created.ok);
        assert!(created.message.is_none());
        assert!(created.path.ends_with("out.txt"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "first\n");

        // An existing file: overwritten with the full new contents (not appended).
        let overwritten = write_file(file.to_str().unwrap(), "second\n");
        assert!(overwritten.ok);
        assert_eq!(fs::read_to_string(&file).unwrap(), "second\n");
    }

    #[test]
    fn write_file_reports_io_failure_as_not_ok_with_a_message() {
        // A path whose parent directory does not exist cannot be written.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-dir").join("x.txt");

        let result = write_file(missing.to_str().unwrap(), "data");
        assert!(!result.ok);
        assert!(result.message.is_some());
        // The unresolved input path is echoed back (canonicalize is skipped on failure).
        assert_eq!(result.path, missing.to_str().unwrap());
    }

    #[test]
    fn search_matches_filenames_case_insensitively_and_skips_heavy_dirs() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), b"x").unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src").join("main.rs"), b"x").unwrap();
        // A skipped heavy dir whose file must NOT show up.
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join("node_modules").join("readme.js"), b"x").unwrap();

        let results = search_files(dir.path().to_str().unwrap(), "read").expect("search");
        let names: Vec<&str> = results.hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, vec!["README.md"]); // node_modules/readme.js skipped
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"x").unwrap();
        let results = search_files(dir.path().to_str().unwrap(), "   ").expect("search");
        assert!(results.hits.is_empty());
    }

    #[test]
    fn resolves_a_code_workspace_to_existing_folders() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("repoA")).unwrap();
        fs::create_dir(dir.path().join("repoB")).unwrap();
        // A workspace file with JSONC comments + a trailing comma + a missing folder.
        let ws = dir.path().join("my.code-workspace");
        fs::write(
            &ws,
            br#"{
                // my repos
                "folders": [
                    { "path": "repoA" },
                    { "path": "repoB", "name": "B" },
                    { "path": "does-not-exist" },
                ],
            }"#,
        )
        .unwrap();

        let resolved = resolve_workspace_file(ws.to_str().unwrap()).expect("resolve");
        assert_eq!(resolved.folders.len(), 2); // missing folder dropped
        assert!(resolved.folders.iter().any(|p| p.ends_with("repoA")));
        assert!(resolved.folders.iter().any(|p| p.ends_with("repoB")));
    }

    #[test]
    fn workspace_file_detection_and_bad_file() {
        assert!(is_workspace_file("Project.code-workspace"));
        assert!(!is_workspace_file("readme.md"));
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("broken.code-workspace");
        fs::write(&ws, b"not json at all {{{").unwrap();
        let error = resolve_workspace_file(ws.to_str().unwrap()).expect_err("bad");
        assert_eq!(error.code, "bad_workspace_file");
    }
}
