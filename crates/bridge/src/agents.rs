//! Local agent-definition discovery (ADR-0090 / packet 09 §3f-bis).
//!
//! Reads the user's **own** agent definitions out of an allowlisted workspace root
//! and surfaces them as runnable dispatch targets. **Read-only** — it never authors
//! or mutates a definition, and it surfaces only metadata (name / description /
//! model / source), never the prompt body. Two sources, each a folder of agent
//! definitions where **every markdown file is one** (operator-decided conventions):
//!  - `.claude/agents/*.md` — Claude Code subagents, backend `claude.local`.
//!  - `.copilot/agents/*.md` — Copilot agents, backend `copilot.local`.
//!
//! Codex has no folder-of-agents convention, so it is deliberately not scanned. The
//! source set is table-driven, so a future source is a one-line addition. The
//! caller (the runtime) enforces the workspace allowlist before discovery runs.

use crate::adapter::AgentBackend;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// A discovered, runnable agent definition. Carries metadata only — the prompt body
/// stays on disk (it is sensitive by default, ADR-0090 D11). **No absolute local
/// path crosses the wire:** `source_path` is workspace-relative, `workspace_label`
/// is the root's final component (for disambiguation), and `id` hashes the root
/// rather than embedding it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// Stable across discoveries: a hash of the workspace root + the relative source
    /// path. Opaque — it does not reveal the absolute path.
    pub id: String,
    pub name: String,
    pub description: String,
    pub backend: AgentBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Path relative to the workspace root (e.g. `.claude/agents/reviewer.md`).
    pub source_path: String,
    /// The workspace root's final path component (e.g. `HoneyDrunk.HoneyHub`), to tell
    /// apart same-named agents from different workspaces — **not** the absolute path.
    pub workspace_label: String,
}

struct AgentSource {
    /// Folder relative to the workspace root; every `*.md` file in it is a definition.
    subdir: &'static str,
    backend: AgentBackend,
}

/// Don't read a candidate file larger than this for frontmatter — an agent
/// definition is small; a huge file is skipped for parsing (still listed by name).
const MAX_DEFINITION_BYTES: u64 = 64 * 1024;

fn sources() -> [AgentSource; 2] {
    [
        AgentSource {
            subdir: ".claude/agents",
            backend: AgentBackend::ClaudeLocal,
        },
        AgentSource {
            subdir: ".copilot/agents",
            backend: AgentBackend::CopilotLocal,
        },
    ]
}

/// Discover every agent definition under `workspace_root`. **Best-effort**: an
/// unreadable source folder or file is skipped, never fatal. Results are ordered
/// deterministically by `(backend, name, id)`. The caller enforces the allowlist.
pub fn discover_agents_in_root(workspace_root: &str) -> Vec<AgentDefinition> {
    let root = Path::new(workspace_root);
    let mut found = Vec::new();

    for source in sources() {
        let dir = root.join(source.subdir);
        // The source folder itself must stay inside the allowlisted root: if it (or an
        // ancestor) is a symlink that escapes the workspace, don't even *list* it —
        // listing leaks external filenames/metadata, which the per-file check below
        // (it only gates reads) would not prevent.
        if !is_within_root(&dir, workspace_root) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // Stay inside the allowlisted workspace: a symlinked agent file could
            // resolve to a target *outside* the root, so require the canonical path to
            // remain within the canonical root. An in-workspace symlink still resolves
            // within the root and is fine; only an escaping one is dropped.
            if !is_within_root(&path, workspace_root) {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !file_name.to_ascii_lowercase().ends_with(".md") {
                continue;
            }
            if let Some(definition) = build_definition(&path, file_name, &source, workspace_root) {
                found.push(definition);
            }
        }
    }

    found.sort_by(|left, right| {
        (&left.backend, &left.name, &left.id).cmp(&(&right.backend, &right.name, &right.id))
    });
    found
}

/// True when `path` resolves (canonically) to a location inside `workspace_root`.
/// Resolving both sides defeats a symlink that would otherwise surface a file from
/// outside the allowlisted workspace. A path that cannot be canonicalized is treated
/// as outside (excluded) rather than risk surfacing it.
fn is_within_root(path: &Path, workspace_root: &str) -> bool {
    match (
        path.canonicalize(),
        Path::new(workspace_root).canonicalize(),
    ) {
        (Ok(real_path), Ok(real_root)) => real_path.starts_with(real_root),
        _ => false,
    }
}

fn build_definition(
    path: &Path,
    file_name: &str,
    source: &AgentSource,
    workspace_root: &str,
) -> Option<AgentDefinition> {
    // Relative source path (no absolute prefix leaked): `<subdir>/<file_name>`.
    let relative = format!("{}/{}", source.subdir, file_name);

    // Parse frontmatter only when the file is small enough; otherwise list it by
    // name. A read failure means we still list the file from its name.
    let content = match fs::metadata(path) {
        Ok(meta) if meta.len() <= MAX_DEFINITION_BYTES => fs::read_to_string(path).ok(),
        _ => None,
    };
    let (name, description, model) = content
        .as_deref()
        .map(parse_frontmatter)
        .unwrap_or((None, None, None));

    let name = name.unwrap_or_else(|| humanize_stem(file_name));
    let description = description.unwrap_or_default();

    Some(AgentDefinition {
        // Hash the root into the id so it stays unique per (workspace, file) without
        // embedding the absolute path.
        id: format!("{}:{}", workspace_hash(workspace_root), relative),
        name,
        description,
        backend: source.backend.clone(),
        model,
        source_path: relative,
        workspace_label: workspace_label(workspace_root),
    })
}

/// The workspace root's final path component, for disambiguating same-named agents
/// across workspaces without exposing the absolute path. When the root has no final
/// component (a bare `/` or drive root), fall back to an **opaque hash-derived**
/// label rather than the raw absolute root — so the no-absolute-path posture holds
/// even for those roots.
fn workspace_label(workspace_root: &str) -> String {
    let candidate = normalized_root(workspace_root);
    Path::new(candidate)
        .file_name()
        .and_then(|component| component.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("workspace-{}", &workspace_hash(workspace_root)[..8]))
}

/// Normalize a root for label/id derivation by trimming trailing separators, so
/// semantically identical roots (`/work` and `/work/`) yield the same label and id.
/// Keeps the original when trimming empties it (e.g. `/`), so the hash fallback in
/// `workspace_label` still applies.
fn normalized_root(workspace_root: &str) -> &str {
    let trimmed = workspace_root.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        workspace_root
    } else {
        trimmed
    }
}

/// A stable, opaque id for a workspace root (FNV-1a 64-bit, dependency-free and
/// deterministic) so the agent id can be unique per workspace without revealing the
/// absolute path. Hashes the **normalized** root, so `/work` and `/work/` match.
fn workspace_hash(workspace_root: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized_root(workspace_root).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// A filename stem turned into a human label: drop the extension, swap `-`/`_` for
/// spaces (`code-reviewer.md` -> `code reviewer`).
fn humanize_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    stem.replace(['-', '_'], " ")
}

/// Pull `name` / `description` / `model` out of a leading `---`-delimited YAML
/// frontmatter block. Deliberately tiny (the crate stays dependency-free): it reads
/// simple `key: value` lines and ignores everything else. Returns `None`s when there
/// is no frontmatter.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>, Option<String>) {
    let trimmed = content.trim_start_matches(['\u{feff}', '\n', '\r', ' ', '\t']);
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (None, None, None);
    };
    // The block ends at the next line that is exactly `---`.
    let Some(end) = rest.find("\n---") else {
        return (None, None, None);
    };
    let block = &rest[..end];

    let mut name = None;
    let mut description = None;
    let mut model = None;
    for line in block.lines() {
        let line = line.trim();
        if let Some(value) = field(line, "name") {
            name = Some(value);
        } else if let Some(value) = field(line, "description") {
            description = Some(value);
        } else if let Some(value) = field(line, "model") {
            model = Some(value);
        }
    }
    (name, description, model)
}

/// `key: value` -> the cleaned `value` (surrounding quotes stripped), or `None` if
/// the line is a different key or has an empty value.
fn field(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.strip_prefix(':')?;
    let value = rest.trim().trim_matches(['"', '\'']).trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("honeyhub-agents-{}", uuid::Uuid::new_v4()))
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn discovers_claude_subagents_with_frontmatter() {
        let root = temp_root();
        write(
            &root.join(".claude/agents/code-reviewer.md"),
            "---\nname: Code Reviewer\ndescription: Reviews diffs against the Grid\nmodel: claude-opus\n---\nYou are a reviewer.\n",
        );
        // A markdown file with no frontmatter still lists, named from the filename.
        write(
            &root.join(".claude/agents/scratch_helper.md"),
            "just a body\n",
        );

        let agents = discover_agents_in_root(root.to_str().unwrap());
        assert_eq!(agents.len(), 2);

        let reviewer = agents.iter().find(|a| a.name == "Code Reviewer").unwrap();
        assert_eq!(reviewer.backend, AgentBackend::ClaudeLocal);
        assert_eq!(reviewer.description, "Reviews diffs against the Grid");
        assert_eq!(reviewer.model.as_deref(), Some("claude-opus"));
        assert_eq!(reviewer.source_path, ".claude/agents/code-reviewer.md");
        // No absolute path leaks anywhere on the wire shape: not the source path, not
        // the id (it hashes the root), and the label is just the root's basename.
        let root_str = root.to_str().unwrap();
        assert!(!reviewer.source_path.contains(root_str));
        assert!(!reviewer.id.contains(root_str));
        assert_eq!(
            reviewer.workspace_label,
            root.file_name().unwrap().to_str().unwrap()
        );

        let scratch = agents.iter().find(|a| a.name == "scratch helper").unwrap();
        assert_eq!(scratch.description, "");
        assert_eq!(scratch.model, None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn discovers_copilot_agents_from_dot_copilot_agents() {
        let root = temp_root();
        write(
            &root.join(".copilot/agents/build-agent.md"),
            "---\nname: Build Agent\ndescription: Runs the build\n---\nbody\n",
        );
        // A markdown file with no frontmatter still lists, named from the filename.
        write(&root.join(".copilot/agents/release.md"), "no frontmatter\n");
        // A non-markdown file in the folder is ignored.
        write(&root.join(".copilot/agents/notes.txt"), "not an agent\n");
        // `.github` is NOT a copilot agents source — anything here is ignored.
        write(
            &root.join(".github/copilot-agent.md"),
            "---\nname: Nope\n---\n",
        );

        let agents = discover_agents_in_root(root.to_str().unwrap());
        let copilot: Vec<_> = agents
            .iter()
            .filter(|a| a.backend == AgentBackend::CopilotLocal)
            .collect();
        assert_eq!(
            copilot.len(),
            2,
            "both .copilot/agents markdown files match"
        );
        assert!(copilot.iter().any(|a| a.name == "Build Agent"));
        assert!(copilot.iter().any(|a| a.name == "release"));
        assert_eq!(
            copilot[0]
                .source_path
                .split('/')
                .take(2)
                .collect::<Vec<_>>(),
            vec![".copilot", "agents"]
        );
        // Nothing was discovered from `.github`.
        assert!(!agents.iter().any(|a| a.source_path.starts_with(".github")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_folders_yield_no_agents_and_no_error() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("root");
        let agents = discover_agents_in_root(root.to_str().unwrap());
        assert!(agents.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_label_never_returns_a_rootless_absolute_path() {
        // A normal root → its basename, and a trailing separator does not defeat it.
        assert_eq!(
            workspace_label("/home/user/HoneyDrunk.HoneyHub"),
            "HoneyDrunk.HoneyHub"
        );
        assert_eq!(workspace_label("/home/user/work/"), "work");
        // Semantically identical roots hash the same (stable id, no duplicate catalog
        // entries) and label the same.
        assert_eq!(workspace_hash("/work"), workspace_hash("/work/"));
        assert_eq!(workspace_label("/work"), workspace_label("/work/"));
        // A root with no final component must NOT serialize the raw absolute root —
        // it falls back to an opaque, hash-derived label. (`/` and `""` are rootless
        // on every platform; a backslash is not a separator off Windows.)
        for rootless in ["/", ""] {
            let label = workspace_label(rootless);
            assert_ne!(label, rootless, "must not echo the raw root {rootless:?}");
            assert!(
                label.starts_with("workspace-"),
                "rootless root {rootless:?} should fall back to a hash label, got {label}"
            );
        }
    }

    #[test]
    fn results_are_deterministically_ordered() {
        let root = temp_root();
        write(
            &root.join(".claude/agents/zeta.md"),
            "---\nname: Zeta\n---\n",
        );
        write(
            &root.join(".claude/agents/alpha.md"),
            "---\nname: Alpha\n---\n",
        );
        let first = discover_agents_in_root(root.to_str().unwrap());
        let second = discover_agents_in_root(root.to_str().unwrap());
        assert_eq!(first, second);
        assert_eq!(first[0].name, "Alpha");
        assert_eq!(first[1].name, "Zeta");
        let _ = fs::remove_dir_all(&root);
    }
}
