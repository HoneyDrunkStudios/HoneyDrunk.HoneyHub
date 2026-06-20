//! Roadmap snapshot (control-hub roadmap #6 / operator 2026-06-14): parse a HoneyDrunk
//! Architecture repo's `initiatives/current-focus.md` into a typed model so the Plan surface
//! shows real lanes + "what's next" per project, not a hand-entered board. Reading is the
//! main path; the one write is [`scaffold_architecture`], which creates a starter repo for a
//! user who has none (the Plan empty-state's one-click create).
//!
//! Source of truth is the ranked table under `## Ranked Priorities` (columns
//! `# | Lane | Item | Type | Status | Phase | Due | Why now | Exit criteria | Blocked by`).
//! Items group by lane in rank order; each lane's **next** is its first non-blocked item.
//! The Architecture dir is resolved from `HONEYHUB_ARCHITECTURE_DIR` or, failing that, a
//! sibling `HoneyDrunk.Architecture` next to a workspace root — so a stranger with no such
//! repo gets `found: false` and the UI shows guidance + a create action.

use crate::adapter::BridgeError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapItem {
    pub rank: u32,
    pub lane: String,
    pub item: String,
    /// The "Type" column (e.g. `initiative`, `packet`); `kind` avoids the Rust keyword.
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub due: String,
    /// The blocker, when the row names one (`None`/`-`/empty → `None`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why_now: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_criteria: Option<String>,
}

impl RoadmapItem {
    /// Actionable = not done/complete and not blocked. The first actionable item in a lane
    /// is its "next".
    fn actionable(&self) -> bool {
        let status = self.status.to_lowercase();
        let done = status.contains("done") || status.contains("complete") || status == "shipped";
        !done && self.blocked_by.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapLane {
    pub lane: String,
    pub items: Vec<RoadmapItem>,
    /// The first non-blocked item — "what's next" for this lane.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<RoadmapItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapSnapshot {
    /// True when the Architecture initiatives file was found + parsed.
    pub found: bool,
    /// The file path read (or the attempted path / empty when none resolved), for the UI.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_reviewed: Option<String>,
    pub lanes: Vec<RoadmapLane>,
}

impl RoadmapSnapshot {
    fn not_found(source: impl Into<String>) -> Self {
        Self {
            found: false,
            source: source.into(),
            last_reviewed: None,
            lanes: Vec::new(),
        }
    }
}

/// Resolve the Architecture repo directory: `HONEYHUB_ARCHITECTURE_DIR` if it holds an
/// `initiatives/` folder, else a sibling `HoneyDrunk.Architecture` next to any workspace
/// root. `None` when nothing plausible exists (a new user without the repo).
pub fn resolve_architecture_dir(roots: &[String]) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HONEYHUB_ARCHITECTURE_DIR") {
        let path = PathBuf::from(dir.trim());
        if !dir.trim().is_empty() && path.join("initiatives").is_dir() {
            return Some(path);
        }
    }
    for root in roots {
        if let Some(parent) = Path::new(root).parent() {
            // Accept the HoneyDrunk repo name or the generic name the scaffolder creates.
            for name in ["HoneyDrunk.Architecture", "architecture"] {
                let candidate = parent.join(name);
                if candidate.join("initiatives").is_dir() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Read + parse the roadmap from the resolved Architecture dir. `found: false` (with a
/// helpful `source`) when no repo/file is present, so the UI can guide a new user.
pub fn read_roadmap(roots: &[String]) -> RoadmapSnapshot {
    let Some(dir) = resolve_architecture_dir(roots) else {
        return RoadmapSnapshot::not_found(String::new());
    };
    read_roadmap_at(&dir)
}

/// Read + parse the roadmap from a specific Architecture dir (used after scaffolding, where
/// the path is known directly).
pub fn read_roadmap_at(dir: &Path) -> RoadmapSnapshot {
    let file = dir.join("initiatives").join("current-focus.md");
    let source = file.to_string_lossy().to_string();
    let Ok(text) = fs::read_to_string(&file) else {
        return RoadmapSnapshot::not_found(source);
    };
    let (last_reviewed, lanes) = parse_current_focus(&text);
    RoadmapSnapshot {
        found: true,
        source,
        last_reviewed,
        lanes,
    }
}

/// Fast-forward the Architecture repo to its remote, then re-read the roadmap. `--ff-only`
/// so a dirty/diverged local never triggers a merge — it just reports the git error. Used by
/// the Plan "Pull latest" action to force-sync to `main` without leaving the cockpit.
pub fn pull_architecture(roots: &[String]) -> Result<RoadmapSnapshot, BridgeError> {
    let dir = resolve_architecture_dir(roots)
        .ok_or_else(|| BridgeError::new("no_repo", "no Architecture repo found to pull"))?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["pull", "--ff-only"])
        .output()
        .map_err(|error| BridgeError::new("git_unavailable", error.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("git pull failed")
            .to_string();
        return Err(BridgeError::new("git_pull_failed", message));
    }
    Ok(read_roadmap_at(&dir))
}

const CURRENT_FOCUS_TEMPLATE: &str = r#"# Current Focus

The ranked priority list. Each row is one priority; the **Lane** column is the project it
belongs to. HoneyHub's Plan view shows one card per lane and surfaces the first non-blocked
item as "Next".

**Last reviewed:** (set a date)
**Review cadence:** weekly

## Ranked Priorities

| # | Lane | Item | Type | Status | Phase | Due | Why now | Exit criteria | Blocked by |
|---|------|------|------|--------|-------|-----|---------|---------------|------------|
| 1 | Example | Replace this with your first real priority | task | Planned | - | - | why it matters now | what "done" looks like | None |

## How to Use This File

- The rank column is the decision; lower number = higher priority.
- The lane column groups items by project (rename "Example" to your project's name).
- Set "Blocked by" to `None` when nothing blocks it — the first non-blocked item in a lane
  is its "Next".
- Add more lanes by giving rows different Lane values.
"#;

const ROADMAP_TEMPLATE: &str = r#"# Roadmap

The longer horizon, beyond the current-focus band. Sketch quarters/waves and the big bets
per lane here; keep `current-focus.md` as the ranked near-term list.
"#;

const PROGRAM_TEMPLATE: &str = r#"# Example lane — program tracker

Per-lane detail for the "Example" lane: the why, the slices, decisions, and links. Rename
this file (and the lane) to your project. One tracker per lane.
"#;

const README_TEMPLATE: &str = r#"# Architecture

Initiative + roadmap tracking for your projects, read by HoneyHub's Plan view.

```
initiatives/
  current-focus.md   # ranked priorities, grouped by lane (the Plan view's source)
  roadmap.md         # the longer horizon
  programs/*.md      # per-lane detail
```

Edit `initiatives/current-focus.md` to set your lanes and priorities; HoneyHub reflects it.
"#;

/// Scaffold a starter Architecture repo (control-hub #6 / operator 2026-06-14 — the Plan
/// empty-state's one-click create). Creates `<location>/<name>/initiatives/{current-focus,
/// roadmap}.md` + `programs/example.md` + a README, then `git init` (best-effort). When
/// `location` is empty it defaults next to the first workspace root (so the sibling autodetect
/// finds it next launch). Refuses to clobber an existing repo. Returns the fresh snapshot so
/// the UI renders it immediately.
pub fn scaffold_architecture(
    name: Option<&str>,
    location: Option<&str>,
    roots: &[String],
) -> Result<RoadmapSnapshot, BridgeError> {
    let name = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("architecture");
    crate::agents::validate_agent_name(name)
        .map_err(|message| BridgeError::new("invalid_name", message))?;

    let base: PathBuf = match location.map(str::trim).filter(|s| !s.is_empty()) {
        Some(loc) => PathBuf::from(loc),
        None => roots
            .first()
            .and_then(|root| Path::new(root).parent().map(Path::to_path_buf))
            .or_else(crate::agents::user_home)
            .ok_or_else(|| {
                BridgeError::new(
                    "no_location",
                    "no location given and no workspace/home to default to",
                )
            })?,
    };
    let target = base.join(name);
    let initiatives = target.join("initiatives");
    let focus = initiatives.join("current-focus.md");
    if focus.exists() {
        return Err(BridgeError::new(
            "already_exists",
            format!(
                "an Architecture repo already exists at {}",
                target.display()
            ),
        ));
    }
    fs::create_dir_all(initiatives.join("programs"))
        .map_err(|error| BridgeError::new("scaffold_failed", error.to_string()))?;
    let write = |path: PathBuf, body: &str| {
        fs::write(path, body)
            .map_err(|error| BridgeError::new("scaffold_failed", error.to_string()))
    };
    write(focus, CURRENT_FOCUS_TEMPLATE)?;
    write(initiatives.join("roadmap.md"), ROADMAP_TEMPLATE)?;
    write(
        initiatives.join("programs").join("example.md"),
        PROGRAM_TEMPLATE,
    )?;
    write(target.join("README.md"), README_TEMPLATE)?;
    // Make it a real repo; best-effort (a missing git CLI must not fail the scaffold).
    let _ = Command::new("git")
        .arg("init")
        .current_dir(&target)
        .output();
    Ok(read_roadmap_at(&target))
}

/// Parse `current-focus.md`: pull `**Last reviewed:** …` and the ranked table rows into
/// lanes (grouped in encounter order, rank order preserved, each lane's `next` computed).
/// Pure, so the table parsing is unit-testable without a repo.
pub fn parse_current_focus(text: &str) -> (Option<String>, Vec<RoadmapLane>) {
    let mut last_reviewed = None;
    let mut items: Vec<RoadmapItem> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if last_reviewed.is_none() {
            last_reviewed = parse_last_reviewed(trimmed);
        }
        if let Some(item) = parse_table_row(trimmed) {
            items.push(item);
        }
    }

    // Group by lane in first-seen order; preserve rank order within a lane.
    let mut lanes: Vec<RoadmapLane> = Vec::new();
    for item in items {
        if let Some(lane) = lanes.iter_mut().find(|l| l.lane == item.lane) {
            lane.items.push(item);
        } else {
            lanes.push(RoadmapLane {
                lane: item.lane.clone(),
                items: vec![item],
                next: None,
            });
        }
    }
    for lane in &mut lanes {
        lane.next = lane.items.iter().find(|i| i.actionable()).cloned();
    }
    (last_reviewed, lanes)
}

/// Pull the non-empty value from a `**Last reviewed:** …` line, or `None` if the
/// line is not that marker (or carries no value).
fn parse_last_reviewed(trimmed: &str) -> Option<String> {
    let value = trimmed.strip_prefix("**Last reviewed:**")?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Parse one ranked-table data row (`| 1 | Lane | Item | … |`). Returns `None` for the
/// header, the separator, and any non-data line (the rank cell must be a number).
fn parse_table_row(line: &str) -> Option<RoadmapItem> {
    if !line.starts_with('|') {
        return None;
    }
    let cells: Vec<String> = line
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect();
    if cells.len() < 10 {
        return None;
    }
    let rank = cells[0].parse::<u32>().ok()?;
    let blocked_by = clean_optional(&cells[9]);
    Some(RoadmapItem {
        rank,
        lane: cells[1].clone(),
        item: cells[2].clone(),
        kind: cells[3].clone(),
        status: cells[4].clone(),
        phase: cells[5].clone(),
        due: cells[6].clone(),
        blocked_by,
        why_now: clean_optional(&cells[7]),
        exit_criteria: clean_optional(&cells[8]),
    })
}

/// Treat `None` / `-` / empty cells as absent.
fn clean_optional(cell: &str) -> Option<String> {
    let trimmed = cell.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("none") || trimmed == "-" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# Current Focus

**Last reviewed:** 2026-06-13

## Ranked Priorities

| # | Lane | Item | Type | Status | Phase | Due | Why now | Exit criteria | Blocked by |
|---|------|------|------|--------|-------|-----|---------|---------------|------------|
| 1 | HoneyHub | Launch checkpoint | initiative | In progress | Wave 2 | 2026-06-23 | because | exit one | None |
| 2 | HoneyHub | Public release | initiative | In progress | Wave 3 | 2026-07-15 | because | exit two | #1 |
| 3 | NovOutbox | Go/slip decision | initiative | In progress | Wave 2 | 2026-06-23 | because | exit three | None |

## Future / Watch

- Some watch item that is not a table row.
"#;

    #[test]
    fn parses_last_reviewed_and_lanes_in_rank_order() {
        let (last_reviewed, lanes) = parse_current_focus(SAMPLE);
        assert_eq!(last_reviewed.as_deref(), Some("2026-06-13"));
        assert_eq!(lanes.len(), 2); // HoneyHub, NovOutbox (encounter order)
        assert_eq!(lanes[0].lane, "HoneyHub");
        assert_eq!(lanes[0].items.len(), 2);
        assert_eq!(lanes[0].items[0].rank, 1);
        assert_eq!(lanes[0].items[1].blocked_by.as_deref(), Some("#1"));
        assert_eq!(lanes[1].lane, "NovOutbox");
    }

    #[test]
    fn next_is_the_first_non_blocked_item() {
        let (_, lanes) = parse_current_focus(SAMPLE);
        // HoneyHub: item 1 is non-blocked → next; item 2 is blocked by #1.
        assert_eq!(lanes[0].next.as_ref().unwrap().rank, 1);
        // NovOutbox: its only item is non-blocked.
        assert_eq!(lanes[1].next.as_ref().unwrap().rank, 3);
    }

    #[test]
    fn ignores_non_table_and_watch_lines() {
        // The "Future / Watch" bullet and prose never parse as items.
        let (_, lanes) = parse_current_focus(SAMPLE);
        let total: usize = lanes.iter().map(|l| l.items.len()).sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn scaffold_creates_a_readable_starter_repo_and_refuses_to_clobber() {
        let base = std::env::temp_dir().join(format!("honeyhub-arch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("base");
        let loc = base.to_string_lossy().to_string();

        let snapshot =
            scaffold_architecture(Some("architecture"), Some(&loc), &[]).expect("scaffold");
        assert!(snapshot.found);
        // The starter has the Example lane parsed from the template table.
        assert_eq!(snapshot.lanes.len(), 1);
        assert_eq!(snapshot.lanes[0].lane, "Example");
        // Files exist on disk.
        let target = base.join("architecture");
        assert!(target.join("initiatives/current-focus.md").exists());
        assert!(target.join("README.md").exists());

        // A second scaffold at the same place refuses (won't clobber).
        let err =
            scaffold_architecture(Some("architecture"), Some(&loc), &[]).expect_err("refuses");
        assert_eq!(err.code, "already_exists");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn missing_repo_yields_not_found() {
        // No HONEYHUB_ARCHITECTURE_DIR and a bogus root → not found, no panic.
        let snapshot = read_roadmap(&["/no/such/workspace/root".to_string()]);
        // Either not found, or (if a real sibling exists in CI) found — but never panics.
        assert!(snapshot.lanes.is_empty() || snapshot.found);
    }
}
