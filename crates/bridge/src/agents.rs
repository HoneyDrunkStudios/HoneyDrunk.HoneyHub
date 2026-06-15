//! Local agent-definition discovery (ADR-0090 / packet 09 §3f-bis).
//!
//! Reads the user's **own** agent definitions and surfaces them as runnable dispatch
//! targets. Discovery surfaces only metadata (name / description / model / source),
//! never the prompt body. Authoring is the one deliberate write path:
//! [`write_claude_agent`] creates a `.claude/agents/<name>.md` so the cockpit can make
//! new agents (packet 09 §3d); the host gates the target folder against the workspace
//! allowlist (project scope) or the home directory (global scope) before calling it.
//! Each source is a folder where **every markdown file is one definition**
//! (operator-decided conventions):
//!  - `.claude/agents/*.md` — Claude Code subagents, backend `claude.local`.
//!  - `.copilot/agents/*.md` — Copilot agents, backend `copilot.local`.
//!
//! Codex has no folder-of-agents convention, so it is deliberately not scanned. The
//! source set is table-driven, so a future source is a one-line addition.
//!
//! Two **scopes** can be scanned: the per-workspace **project** folders
//! (`<root>/.claude/agents`, `<root>/.copilot/agents`) and the user-global **global**
//! folders under the home directory (`~/.claude/agents`, `~/.copilot/agents`). The project
//! scope is always scanned within the workspace allowlist; the global scope is **opt-in,
//! off by default** — it reads the user's own home config, which is outside the workspace
//! allowlist, so the runtime only scans it when the host explicitly enables it (ADR-0090
//! keeps discovery within configured roots unless deliberately widened). Within a backend,
//! **a project definition shadows a global one** (mirroring Claude's project-overrides-user
//! precedence).
//!
//! Definitions are deduped by **name** into **one entry runnable on multiple backends**
//! (operator-decided): an [`AgentDefinition`] is a name plus the set of backends that
//! define it, each carrying the winning definition's metadata for that backend. So a
//! `reviewer` defined in both `.claude/agents` and `.copilot/agents` is one entry listing
//! both backends; the caller chooses the backend at dispatch time.

use crate::adapter::AgentBackend;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Where a definition was found: a per-workspace repo folder, or the user-global home
/// folder. Repo shadows global within a backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentScope {
    Project,
    Global,
}

/// One backend a discovered agent can run on, carrying the metadata of the **winning**
/// definition for that backend (a project definition beats a global one). Metadata only
/// — the prompt body stays on disk (it is sensitive by default, ADR-0090 D11). **No
/// absolute local path crosses the wire:** `source_path` is relative to its scan root and
/// `workspace_label` is a basename (or the constant `"global"`), never an absolute path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendBinding {
    pub backend: AgentBackend,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Path relative to the scan root (e.g. `.claude/agents/reviewer.md`). For a global
    /// definition it is relative to the user's home, never the absolute home path.
    pub source_path: String,
    pub scope: AgentScope,
    /// For a **project** binding: the workspace root's final path component (e.g.
    /// `HoneyDrunk.HoneyHub`), to disambiguate same-named agents across workspaces. For a
    /// **global** binding: the constant [`GLOBAL_LABEL`] — the home directory's basename
    /// is the username, which must never be leaked.
    pub workspace_label: String,
}

/// A discovered, runnable agent — identified by **name** and runnable on the **set of
/// backends** that define it (operator-decided one-entry-per-name model). Metadata only.
/// **No absolute local path crosses the wire:** `id` is an opaque hash of the name and
/// every per-backend path is relative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// Stable, opaque id derived from the name (the dedupe key). Reveals no path.
    pub id: String,
    pub name: String,
    /// The backends this agent can run on, ordered by backend. Always non-empty.
    pub backends: Vec<AgentBackendBinding>,
}

/// A single discovered file, before cross-name / cross-backend dedupe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAgent {
    pub name: String,
    pub backend: AgentBackend,
    pub description: String,
    pub model: Option<String>,
    pub source_path: String,
    pub scope: AgentScope,
    pub workspace_label: String,
}

/// The `workspace_label` used for every global-scope binding. The home directory's
/// basename is the username, so a constant is used instead — the no-path-leak posture
/// must hold for global definitions too.
pub const GLOBAL_LABEL: &str = "global";

struct SubdirSource {
    /// Folder relative to the scan root; every `*.md` file in it is a definition.
    subdir: &'static str,
    backend: AgentBackend,
}

/// Don't read a candidate file larger than this for frontmatter — an agent definition is
/// small; a huge file is skipped for parsing (still listed by name).
const MAX_DEFINITION_BYTES: u64 = 64 * 1024;

fn sources() -> [SubdirSource; 2] {
    [
        SubdirSource {
            subdir: ".claude/agents",
            backend: AgentBackend::ClaudeLocal,
        },
        SubdirSource {
            subdir: ".copilot/agents",
            backend: AgentBackend::CopilotLocal,
        },
    ]
}

/// Resolve the user's home directory dependency-free: `HOME` (unix) then `USERPROFILE`
/// (Windows). `None` when neither is set (global scanning is then simply skipped).
pub fn user_home() -> Option<PathBuf> {
    // Filter each var for emptiness *before* the fallback: a `HOME` set to `""` must not
    // short-circuit `or_else` (that would disable global discovery instead of trying
    // `USERPROFILE`).
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// Discover the raw **project** (repo) candidates under one workspace root. Best-effort:
/// an unreadable source folder or file is skipped, never fatal. The caller enforces the
/// workspace allowlist before calling this.
pub fn discover_raw_in_root(workspace_root: &str) -> Vec<RawAgent> {
    let root = Path::new(workspace_root);
    let label = workspace_label(workspace_root);
    let mut found = Vec::new();
    for source in sources() {
        let dir = root.join(source.subdir);
        scan_dir(
            &dir,
            root,
            source.subdir,
            &source.backend,
            AgentScope::Project,
            &label,
            &mut found,
        );
    }
    found
}

/// Discover raw **project** candidates under a workspace root **and its immediate
/// subdirectories** (depth 1). This handles the common "a parent folder that holds many
/// repos is the workspace root" case — each child repo's `.claude/agents` is found and
/// labeled by the child's own basename, so per-repo agents surface without adding every
/// repo as its own root. Bounded to one level (the root + its direct children) to avoid
/// walking deep trees; deeper layouts are still covered by adding those roots directly or
/// via a `.code-workspace`. Best-effort: unreadable entries are skipped.
pub fn discover_raw_in_root_recursive(workspace_root: &str) -> Vec<RawAgent> {
    let mut found = discover_raw_in_root(workspace_root);
    let root = Path::new(workspace_root);
    let Ok(entries) = fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        // Only descend into real directories within the root (skip files; skip a symlink
        // that escapes the root, mirroring `scan_dir`'s containment posture).
        if !child.is_dir() || !is_within_root(&child, root) {
            continue;
        }
        if let Some(child_str) = child.to_str() {
            found.extend(discover_raw_in_root(child_str));
        }
    }
    found
}

/// Discover the raw **global** (user) candidates under `home` (the parent of
/// `.claude/agents` / `.copilot/agents`). Scanned once, independent of any workspace.
/// Best-effort, same as the project scan. Containment is checked against `home`, so a
/// symlink in a global agents folder cannot surface a file from outside the home tree.
pub fn discover_raw_global_in(home: &Path) -> Vec<RawAgent> {
    let mut found = Vec::new();
    for source in sources() {
        let dir = home.join(source.subdir);
        scan_dir(
            &dir,
            home,
            source.subdir,
            &source.backend,
            AgentScope::Global,
            GLOBAL_LABEL,
            &mut found,
        );
    }
    found
}

/// Dedupe raw candidates into **one entry per name**, each runnable on the set of
/// backends that define it. Within a `(name, backend)`, a **project** definition shadows
/// a **global** one; further ties break deterministically by workspace label then source
/// path, so the metadata surfaced for a backend is always the same winning definition's.
/// Backends within an entry, and entries themselves, are deterministically ordered.
pub fn merge_agents(mut raws: Vec<RawAgent>) -> Vec<AgentDefinition> {
    // Sort by precedence so that, per (name, backend), the first candidate is the winner:
    // project before global, then label, then path. Name/backend lead so equal keys group.
    raws.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.backend.cmp(&right.backend))
            .then_with(|| scope_rank(left.scope).cmp(&scope_rank(right.scope)))
            .then_with(|| left.workspace_label.cmp(&right.workspace_label))
            .then_with(|| left.source_path.cmp(&right.source_path))
    });

    // name -> (backend -> winning binding). BTreeMaps keep names and backends ordered.
    let mut by_name: BTreeMap<String, BTreeMap<AgentBackend, AgentBackendBinding>> =
        BTreeMap::new();
    for raw in raws {
        let backends = by_name.entry(raw.name.clone()).or_default();
        // First writer wins: candidates are pre-sorted by precedence, so a later same
        // (name, backend) entry (a shadowed project dup or a global fallback) is ignored.
        backends
            .entry(raw.backend)
            .or_insert_with(|| AgentBackendBinding {
                backend: raw.backend,
                description: raw.description.clone(),
                model: raw.model.clone(),
                source_path: raw.source_path.clone(),
                scope: raw.scope,
                workspace_label: raw.workspace_label.clone(),
            });
    }

    by_name
        .into_iter()
        .map(|(name, backends)| AgentDefinition {
            id: fnv64_hex(name.as_bytes()),
            name,
            // `into_values` yields in `AgentBackend` order (the BTreeMap key order).
            backends: backends.into_values().collect(),
        })
        .collect()
}

/// Convenience for a single project root: discover its raw candidates and merge them into
/// the one-entry-per-name shape. (The runtime combines multiple roots + the global scope
/// and applies the backend allowlist itself before merging.)
pub fn discover_agents_in_root(workspace_root: &str) -> Vec<AgentDefinition> {
    merge_agents(discover_raw_in_root(workspace_root))
}

/// The result of authoring an agent: its name and the path it was written to, relative to
/// the scan root (so no absolute local path crosses the wire), plus its scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWriteOutcome {
    pub name: String,
    pub source_path: String,
    pub scope: AgentScope,
}

/// Validate an agent name: a single path segment usable as a filename — letters, digits,
/// `.`, `_`, `-`, non-empty, not a dotfile, no `..`, no separators. Mirrors the slug the
/// CLIs accept and keeps the write inside `.claude/agents`.
pub fn validate_agent_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("agent name is empty".to_string());
    }
    if trimmed.starts_with('.') {
        return Err("agent name must not start with '.'".to_string());
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err("agent name may contain only letters, digits, '.', '_', '-'".to_string())
    }
}

/// Render the markdown for a Claude agent definition: YAML frontmatter (name +
/// description, plus an optional model) followed by the prompt body.
pub fn render_agent_markdown(
    name: &str,
    description: &str,
    model: Option<&str>,
    body: &str,
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", name.trim()));
    out.push_str(&format!(
        "description: {}\n",
        description.trim().replace('\n', " ")
    ));
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        out.push_str(&format!("model: {model}\n"));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');
    out
}

/// Author a Claude agent definition under `<dir>/.claude/agents/<name>.md`, creating the
/// folder if needed. `dir` is the already-authorized target root (a workspace root for a
/// project agent, or the home directory for a global one); the host enforces that gate.
/// Returns the path written, **relative to `dir`** (e.g. `.claude/agents/x.md`).
pub fn write_claude_agent(
    dir: &Path,
    name: &str,
    description: &str,
    model: Option<&str>,
    body: &str,
    scope: AgentScope,
) -> Result<AgentWriteOutcome, String> {
    validate_agent_name(name)?;
    let name = name.trim();
    let agents_dir = dir.join(".claude").join("agents");
    fs::create_dir_all(&agents_dir)
        .map_err(|error| format!("could not create agents folder: {error}"))?;
    let file_path = agents_dir.join(format!("{name}.md"));
    let contents = render_agent_markdown(name, description, model, body);
    fs::write(&file_path, contents)
        .map_err(|error| format!("could not write agent file: {error}"))?;
    Ok(AgentWriteOutcome {
        name: name.to_string(),
        source_path: format!(".claude/agents/{name}.md"),
        scope,
    })
}

fn scan_dir(
    dir: &Path,
    containment_root: &Path,
    subdir: &str,
    backend: &AgentBackend,
    scope: AgentScope,
    workspace_label: &str,
    out: &mut Vec<RawAgent>,
) {
    // The source folder itself must stay inside the containment root: if it (or an
    // ancestor) is a symlink that escapes the root, don't even *list* it — listing leaks
    // external filenames/metadata, which the per-file check below (it only gates reads)
    // would not prevent.
    if !is_within_root(dir, containment_root) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Containment FIRST, before any metadata/`is_file` stat: those follow symlinks, so
        // checking the file type first would let an escaping symlink's *target* (outside
        // the root) be stat'd before we reject it. A symlinked agent file could resolve to
        // a target outside the root, so require the canonical path to remain within the
        // canonical root. An in-root symlink still resolves within the root and is fine;
        // only an escaping one is dropped.
        if !is_within_root(&path, containment_root) {
            continue;
        }
        // Safe to stat now: the path resolves within the containment root.
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        if let Some(raw) = build_raw(&path, file_name, subdir, backend, scope, workspace_label) {
            out.push(raw);
        }
    }
}

/// True when `path` resolves (canonically) to a location inside `containment_root`.
/// Resolving both sides defeats a symlink that would otherwise surface a file from
/// outside the root. A path that cannot be canonicalized is treated as outside (excluded)
/// rather than risk surfacing it.
fn is_within_root(path: &Path, containment_root: &Path) -> bool {
    match (path.canonicalize(), containment_root.canonicalize()) {
        (Ok(real_path), Ok(real_root)) => real_path.starts_with(real_root),
        _ => false,
    }
}

fn build_raw(
    path: &Path,
    file_name: &str,
    subdir: &str,
    backend: &AgentBackend,
    scope: AgentScope,
    workspace_label: &str,
) -> Option<RawAgent> {
    // Relative source path (no absolute prefix leaked): `<subdir>/<file_name>`.
    let relative = format!("{subdir}/{file_name}");

    // Parse frontmatter only when the file is small enough; otherwise list it by name. A
    // read failure means we still list the file from its name.
    let content = match fs::metadata(path) {
        Ok(meta) if meta.len() <= MAX_DEFINITION_BYTES => fs::read_to_string(path).ok(),
        _ => None,
    };
    let (name, description, model) = content
        .as_deref()
        .map(parse_frontmatter)
        .unwrap_or((None, None, None));

    Some(RawAgent {
        name: name.unwrap_or_else(|| humanize_stem(file_name)),
        backend: *backend,
        description: description.unwrap_or_default(),
        model,
        source_path: relative,
        scope,
        workspace_label: workspace_label.to_string(),
    })
}

fn scope_rank(scope: AgentScope) -> u8 {
    match scope {
        AgentScope::Project => 0,
        AgentScope::Global => 1,
    }
}

/// The workspace root's final path component, for disambiguating same-named agents across
/// workspaces without exposing the absolute path. When the root has no final component (a
/// bare `/` or drive root), fall back to an **opaque hash-derived** label rather than the
/// raw absolute root — so the no-absolute-path posture holds even for those roots.
fn workspace_label(workspace_root: &str) -> String {
    let candidate = normalized_root(workspace_root);
    Path::new(candidate)
        .file_name()
        .and_then(|component| component.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("workspace-{}", &workspace_hash(workspace_root)[..8]))
}

/// Normalize a root for label derivation by trimming trailing separators, so
/// semantically identical roots (`/work` and `/work/`) yield the same label. Keeps the
/// original when trimming empties it (e.g. `/`), so the hash fallback still applies.
fn normalized_root(workspace_root: &str) -> &str {
    let trimmed = workspace_root.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        workspace_root
    } else {
        trimmed
    }
}

/// A stable, opaque id for a workspace root (FNV-1a 64-bit over the **normalized** root),
/// used only for the rootless-root label fallback. Dependency-free and deterministic.
fn workspace_hash(workspace_root: &str) -> String {
    fnv64_hex(normalized_root(workspace_root).as_bytes())
}

/// FNV-1a 64-bit over arbitrary bytes, as zero-padded hex. Dependency-free, deterministic
/// — used for the opaque agent id (over the name) and the workspace label fallback.
fn fnv64_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// A filename stem turned into a human label: drop the extension, swap `-`/`_` for spaces
/// (`code-reviewer.md` -> `code reviewer`).
fn humanize_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    stem.replace(['-', '_'], " ")
}

/// Pull `name` / `description` / `model` out of a leading `---`-delimited YAML
/// frontmatter block. Deliberately tiny (the crate stays dependency-free): it reads simple
/// `key: value` lines and ignores everything else. Returns `None`s when there is no
/// frontmatter.
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

/// `key: value` -> the cleaned `value` (surrounding quotes stripped), or `None` if the
/// line is a different key or has an empty value.
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

    /// Find the single binding for a backend in a merged definition.
    fn binding(agent: &AgentDefinition, backend: AgentBackend) -> Option<&AgentBackendBinding> {
        agent.backends.iter().find(|b| b.backend == backend)
    }

    #[test]
    fn recursive_discovery_finds_agents_in_immediate_subrepos() {
        // A parent folder that holds two repos, each with its own .claude/agents.
        let parent = temp_root();
        write(
            &parent.join("repo-a/.claude/agents/alpha.md"),
            "---\nname: alpha\ndescription: A\n---\nbody\n",
        );
        write(
            &parent.join("repo-b/.claude/agents/beta.md"),
            "---\nname: beta\ndescription: B\n---\nbody\n",
        );
        // An agent directly at the parent root is found too.
        write(
            &parent.join(".claude/agents/root-agent.md"),
            "---\nname: root-agent\ndescription: R\n---\nbody\n",
        );

        let raws = discover_raw_in_root_recursive(parent.to_str().unwrap());
        let names: Vec<&str> = raws.iter().map(|raw| raw.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        assert!(names.contains(&"root-agent"));
        // Per-repo agents are labeled by their own repo's basename, not the parent's.
        let alpha = raws.iter().find(|raw| raw.name == "alpha").unwrap();
        assert_eq!(alpha.workspace_label, "repo-a");
    }

    #[test]
    fn validate_agent_name_accepts_slugs_and_rejects_paths() {
        assert!(validate_agent_name("code-reviewer").is_ok());
        assert!(validate_agent_name("Agent_1.v2").is_ok());
        assert!(validate_agent_name("").is_err());
        assert!(validate_agent_name(".hidden").is_err());
        assert!(validate_agent_name("../escape").is_err());
        assert!(validate_agent_name("a/b").is_err());
        assert!(validate_agent_name("a b").is_err());
    }

    #[test]
    fn render_agent_markdown_emits_frontmatter_and_optional_model() {
        let with_model = render_agent_markdown("rev", "Reviews diffs", Some("opus"), "Body here");
        assert!(with_model
            .starts_with("---\nname: rev\ndescription: Reviews diffs\nmodel: opus\n---\n\n"));
        assert!(with_model.ends_with("Body here\n"));

        // No model -> no model line; a multi-line description collapses to one line.
        let no_model = render_agent_markdown("rev", "Line one\nLine two", None, "Body");
        assert!(!no_model.contains("model:"));
        assert!(no_model.contains("description: Line one Line two\n"));
    }

    #[test]
    fn write_claude_agent_round_trips_through_discovery() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("create root");
        let outcome = write_claude_agent(
            &root,
            "fixer",
            "Fixes things",
            Some("opus"),
            "You fix things.",
            AgentScope::Project,
        )
        .expect("write agent");
        assert_eq!(outcome.name, "fixer");
        assert_eq!(outcome.source_path, ".claude/agents/fixer.md");

        let agents = discover_agents_in_root(root.to_str().unwrap());
        let fixer = agents
            .iter()
            .find(|a| a.name == "fixer")
            .expect("discovered");
        let claude = binding(fixer, AgentBackend::ClaudeLocal).expect("claude binding");
        assert_eq!(claude.description, "Fixes things");
        assert_eq!(claude.model.as_deref(), Some("opus"));
    }

    #[test]
    fn write_claude_agent_rejects_unsafe_name() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("create root");
        assert!(write_claude_agent(&root, "../evil", "x", None, "y", AgentScope::Project).is_err());
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
        // One entry, runnable on exactly the one backend that defines it.
        assert_eq!(reviewer.backends.len(), 1);
        let claude = binding(reviewer, AgentBackend::ClaudeLocal).unwrap();
        assert_eq!(claude.description, "Reviews diffs against the Grid");
        assert_eq!(claude.model.as_deref(), Some("claude-opus"));
        assert_eq!(claude.source_path, ".claude/agents/code-reviewer.md");
        assert_eq!(claude.scope, AgentScope::Project);
        // No absolute path leaks anywhere on the wire shape: not the source path, not the
        // id (it hashes the name), and the label is just the root's basename.
        let root_str = root.to_str().unwrap();
        assert!(!claude.source_path.contains(root_str));
        assert!(!reviewer.id.contains(root_str));
        assert_eq!(
            claude.workspace_label,
            root.file_name().unwrap().to_str().unwrap()
        );

        let scratch = agents.iter().find(|a| a.name == "scratch helper").unwrap();
        let scratch_claude = binding(scratch, AgentBackend::ClaudeLocal).unwrap();
        assert_eq!(scratch_claude.description, "");
        assert_eq!(scratch_claude.model, None);

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
            .filter(|a| binding(a, AgentBackend::CopilotLocal).is_some())
            .collect();
        assert_eq!(
            copilot.len(),
            2,
            "both .copilot/agents markdown files match"
        );
        assert!(copilot.iter().any(|a| a.name == "Build Agent"));
        assert!(copilot.iter().any(|a| a.name == "release"));
        let build = agents.iter().find(|a| a.name == "Build Agent").unwrap();
        let build_copilot = binding(build, AgentBackend::CopilotLocal).unwrap();
        assert_eq!(
            build_copilot
                .source_path
                .split('/')
                .take(2)
                .collect::<Vec<_>>(),
            vec![".copilot", "agents"]
        );
        // Nothing was discovered from `.github`.
        assert!(!agents.iter().any(|a| a.name == "Nope"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn one_name_in_two_backends_is_a_single_multi_backend_entry() {
        let root = temp_root();
        write(
            &root.join(".claude/agents/reviewer.md"),
            "---\nname: Reviewer\ndescription: Claude reviewer\nmodel: claude-opus\n---\nbody\n",
        );
        write(
            &root.join(".copilot/agents/reviewer.md"),
            "---\nname: Reviewer\ndescription: Copilot reviewer\n---\nbody\n",
        );

        let agents = discover_agents_in_root(root.to_str().unwrap());
        // ONE entry by name, runnable on BOTH backends.
        assert_eq!(agents.len(), 1);
        let reviewer = &agents[0];
        assert_eq!(reviewer.name, "Reviewer");
        assert_eq!(reviewer.backends.len(), 2);
        // Backends are ordered (claude before copilot) and each carries its own metadata.
        assert_eq!(reviewer.backends[0].backend, AgentBackend::ClaudeLocal);
        assert_eq!(reviewer.backends[0].description, "Claude reviewer");
        assert_eq!(reviewer.backends[0].model.as_deref(), Some("claude-opus"));
        assert_eq!(reviewer.backends[1].backend, AgentBackend::CopilotLocal);
        assert_eq!(reviewer.backends[1].description, "Copilot reviewer");
        assert_eq!(reviewer.backends[1].model, None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn global_definitions_are_discovered_and_scoped() {
        let home = temp_root();
        write(
            &home.join(".claude/agents/global-helper.md"),
            "---\nname: Global Helper\ndescription: A user-global agent\n---\nbody\n",
        );

        let agents = merge_agents(discover_raw_global_in(&home));
        assert_eq!(agents.len(), 1);
        let helper = &agents[0];
        assert_eq!(helper.name, "Global Helper");
        let claude = binding(helper, AgentBackend::ClaudeLocal).unwrap();
        assert_eq!(claude.scope, AgentScope::Global);
        // A global binding labels itself with the constant, never the home basename
        // (which is the username).
        assert_eq!(claude.workspace_label, GLOBAL_LABEL);
        assert_eq!(claude.source_path, ".claude/agents/global-helper.md");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn project_shadows_global_within_a_backend() {
        let root = temp_root();
        let home = temp_root();
        // Same name + backend in both scopes; the project one must win.
        write(
            &root.join(".claude/agents/reviewer.md"),
            "---\nname: Reviewer\ndescription: PROJECT reviewer\n---\nbody\n",
        );
        write(
            &home.join(".claude/agents/reviewer.md"),
            "---\nname: Reviewer\ndescription: GLOBAL reviewer\n---\nbody\n",
        );

        let mut raws = discover_raw_in_root(root.to_str().unwrap());
        raws.extend(discover_raw_global_in(&home));
        let agents = merge_agents(raws);

        assert_eq!(agents.len(), 1);
        let reviewer = &agents[0];
        assert_eq!(
            reviewer.backends.len(),
            1,
            "one backend, deduped across scopes"
        );
        let claude = binding(reviewer, AgentBackend::ClaudeLocal).unwrap();
        assert_eq!(
            claude.description, "PROJECT reviewer",
            "project shadows global"
        );
        assert_eq!(claude.scope, AgentScope::Project);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn project_and_global_on_different_backends_merge_into_one_entry() {
        // A name defined on claude in the project and on copilot globally → one entry,
        // two backends, each keeping its own scope.
        let root = temp_root();
        let home = temp_root();
        write(
            &root.join(".claude/agents/helper.md"),
            "---\nname: Helper\ndescription: project claude\n---\nbody\n",
        );
        write(
            &home.join(".copilot/agents/helper.md"),
            "---\nname: Helper\ndescription: global copilot\n---\nbody\n",
        );

        let mut raws = discover_raw_in_root(root.to_str().unwrap());
        raws.extend(discover_raw_global_in(&home));
        let agents = merge_agents(raws);

        assert_eq!(agents.len(), 1);
        let helper = &agents[0];
        assert_eq!(helper.backends.len(), 2);
        assert_eq!(
            binding(helper, AgentBackend::ClaudeLocal).unwrap().scope,
            AgentScope::Project
        );
        assert_eq!(
            binding(helper, AgentBackend::CopilotLocal).unwrap().scope,
            AgentScope::Global
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_folders_yield_no_agents_and_no_error() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("root");
        let agents = discover_agents_in_root(root.to_str().unwrap());
        assert!(agents.is_empty());
        // A missing global home folder is likewise empty, not an error.
        let home = temp_root();
        fs::create_dir_all(&home).expect("home");
        assert!(merge_agents(discover_raw_global_in(&home)).is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn workspace_label_never_returns_a_rootless_absolute_path() {
        // A normal root → its basename, and a trailing separator does not defeat it.
        assert_eq!(
            workspace_label("/home/user/HoneyDrunk.HoneyHub"),
            "HoneyDrunk.HoneyHub"
        );
        assert_eq!(workspace_label("/home/user/work/"), "work");
        // Semantically identical roots label the same.
        assert_eq!(workspace_label("/work"), workspace_label("/work/"));
        // A root with no final component must NOT serialize the raw absolute root — it
        // falls back to an opaque, hash-derived label. (`/` and `""` are rootless on every
        // platform; a backslash is not a separator off Windows.)
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
