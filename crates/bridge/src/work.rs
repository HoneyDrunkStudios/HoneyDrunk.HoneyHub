//! **Work connectors** (the "view everything assigned to me" hub): opt-in, read-only sources
//! of work items the operator owns, pulled from the tools they already use. Each source is a
//! connector the cockpit enables explicitly (nothing is queried unless asked for by id), and
//! the bridge only ever **reads** — it never edits, closes, or transitions anything.
//!
//! v1 ships the **GitHub** connector, which rides the already-authenticated `gh` CLI (so no
//! token is stored in HoneyHub): issues assigned to you, PRs you authored, and PRs that
//! request your review. Azure DevOps and others slot in behind the same [`WorkSource`] shape.

use crate::backend_catalog::program_on_path;
use serde::{Deserialize, Serialize};
use std::process::Command;

/// The kind of a work item, so the cockpit can icon/split it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemKind {
    Issue,
    PullRequest,
    WorkItem,
}

/// One unit of work the operator owns, normalized across connectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    /// Stable id for de-duplication / React keys (the item URL works well).
    pub id: String,
    /// The connector this came from (`github`, later `ado`).
    pub source: String,
    pub kind: WorkItemKind,
    /// A clean bucket for the UI's split view (e.g. `Assigned`, `Authored`, `Review requested`).
    pub category: String,
    pub title: String,
    /// `owner/name` (GitHub) or project (ADO), for grouping + display.
    pub repository: String,
    pub url: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

/// One connector's result: whether it's available (configured/authed) and its items, or a
/// sanitized error so the cockpit can show "GitHub: not signed in" without leaking specifics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSource {
    pub source: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<WorkItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSnapshot {
    pub sources: Vec<WorkSource>,
}

/// The connector ids the bridge knows how to serve.
pub const GITHUB_SOURCE: &str = "github";
pub const ADO_SOURCE: &str = "ado";

/// Fetch the requested work sources (by connector id). Only the ids in `sources` are queried
/// — nothing runs for a connector the cockpit hasn't opted into. Unknown ids are ignored.
pub fn snapshot(sources: &[String]) -> WorkSnapshot {
    let mut out = Vec::new();
    for source in sources {
        // Unknown connector ids are ignored (forward-compat with newer cockpits).
        match source.as_str() {
            GITHUB_SOURCE => out.push(fetch_github()),
            ADO_SOURCE => out.push(fetch_ado()),
            _ => {}
        }
    }
    WorkSnapshot { sources: out }
}

/// Fetch the GitHub connector via the `gh` CLI: assigned issues + authored PRs + review
/// requests. Read-only. When `gh` is missing or not authenticated, returns an unavailable
/// source with a short, non-leaking hint rather than failing the whole snapshot.
fn fetch_github() -> WorkSource {
    if !program_on_path("gh") {
        return WorkSource {
            source: GITHUB_SOURCE.to_string(),
            available: false,
            error: Some("GitHub CLI (gh) not found on PATH".to_string()),
            items: Vec::new(),
        };
    }

    let queries = [
        (
            WorkItemKind::Issue,
            "Assigned",
            vec![
                "search",
                "issues",
                "--assignee",
                "@me",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,repository,url,state,updatedAt,labels",
            ],
        ),
        (
            WorkItemKind::PullRequest,
            "Authored",
            vec![
                "search",
                "prs",
                "--author",
                "@me",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,repository,url,state,updatedAt,labels",
            ],
        ),
        (
            WorkItemKind::PullRequest,
            "Review requested",
            vec![
                "search",
                "prs",
                "--review-requested",
                "@me",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,repository,url,state,updatedAt,labels",
            ],
        ),
        (
            // Issues/PRs that @-mention you (including in comments) — the "tagged me" source.
            WorkItemKind::Issue,
            "Mentioned",
            vec![
                "search",
                "issues",
                "--mentions",
                "@me",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,repository,url,state,updatedAt,labels",
            ],
        ),
    ];

    let mut items: Vec<WorkItem> = Vec::new();
    let mut first_error: Option<String> = None;
    for (kind, category, args) in queries {
        match run_gh(&args) {
            Ok(json) => items.extend(parse_github_items(&json, kind, category)),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    // De-dup: a PR can be both authored and review-requested — keep the first category seen.
    dedup_by_id(&mut items);

    if items.is_empty() && first_error.is_some() {
        return WorkSource {
            source: GITHUB_SOURCE.to_string(),
            available: false,
            error: first_error,
            items: Vec::new(),
        };
    }
    WorkSource {
        source: GITHUB_SOURCE.to_string(),
        available: true,
        error: None,
        items,
    }
}

/// Run `gh <args>` and return stdout. Errors are sanitized to a short hint (the most common
/// cause is "not authenticated"), never the raw stderr (which can carry tokens/urls).
fn run_gh(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .output()
        .map_err(|_| "could not run the GitHub CLI".to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("auth") || stderr.contains("logged in") {
            return Err("GitHub CLI is not signed in (run `gh auth login`)".to_string());
        }
        return Err("the GitHub CLI returned an error".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse `gh search issues/prs --json …` output (a JSON array) into normalized work items.
pub fn parse_github_items(json: &str, kind: WorkItemKind, category: &str) -> Vec<WorkItem> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let url = row.get("url")?.as_str()?.trim().to_string();
            if url.is_empty() {
                return None;
            }
            let title = row
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // `repository` is an object carrying `nameWithOwner`.
            let repository = row
                .get("repository")
                .and_then(|v| v.get("nameWithOwner"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let state = row
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_string();
            let number = row.get("number").and_then(|v| v.as_u64());
            let updated_at = row
                .get("updatedAt")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            let labels = row
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|array| {
                    array
                        .iter()
                        .filter_map(|label| label.get("name").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(WorkItem {
                id: url.clone(),
                source: GITHUB_SOURCE.to_string(),
                kind,
                category: category.to_string(),
                title,
                repository,
                url,
                state,
                number,
                updated_at,
                labels,
            })
        })
        .collect()
}

/// Drop later duplicates by `id`, preserving order (first category wins).
fn dedup_by_id(items: &mut Vec<WorkItem>) {
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));
}

/// WIQL for "work items assigned to me that are still open", newest-changed first.
const ADO_WIQL: &str = "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.TeamProject] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC";

/// Fetch the Azure DevOps connector via the `az boards` CLI: work items assigned to you across
/// your configured org/project. Read-only. Relies on the operator's existing `az` sign-in and
/// `az devops configure` defaults — when `az` is missing or no org is configured, returns an
/// unavailable source with a short hint rather than failing the whole snapshot.
fn fetch_ado() -> WorkSource {
    if !program_on_path("az") {
        return WorkSource {
            source: ADO_SOURCE.to_string(),
            available: false,
            error: Some("Azure CLI (az) not found on PATH".to_string()),
            items: Vec::new(),
        };
    }
    match run_az_boards() {
        Ok(json) => {
            let mut items = parse_ado_items(&json);
            // Best-effort: also surface PRs awaiting your review (the "PR put up for you"
            // source for ADO). Resolving the signed-in user can fail (Graph perms), and the
            // PR query needs a default project — either failure just contributes no PRs rather
            // than flipping the whole source unavailable.
            items.extend(fetch_ado_review_prs());
            dedup_by_id(&mut items);
            WorkSource {
                source: ADO_SOURCE.to_string(),
                available: true,
                error: None,
                items,
            }
        }
        Err(error) => WorkSource {
            source: ADO_SOURCE.to_string(),
            available: false,
            error: Some(error),
            items: Vec::new(),
        },
    }
}

/// Run `az boards query --wiql … -o json`; sanitize errors (the common causes are the devops
/// extension missing or no default org), never leaking raw stderr (which can carry org URLs).
fn run_az_boards() -> Result<String, String> {
    let output = Command::new("az")
        .args(["boards", "query", "--wiql", ADO_WIQL, "-o", "json"])
        .output()
        .map_err(|_| "could not run the Azure CLI".to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("not configured")
            || stderr.contains("organization")
            || stderr.contains("--org")
        {
            return Err(
                "no default Azure DevOps org (run `az devops configure --defaults organization=…`)"
                    .to_string(),
            );
        }
        if stderr.contains("not in the")
            || stderr.contains("az extension")
            || stderr.contains("devops")
        {
            return Err("the Azure DevOps CLI extension isn't installed (`az extension add --name azure-devops`)".to_string());
        }
        if stderr.contains("login") || stderr.contains("credential") || stderr.contains("sign in") {
            return Err("Azure CLI is not signed in (run `az login`)".to_string());
        }
        return Err("the Azure CLI returned an error".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse `az boards query --wiql … -o json` output (an array of work items, each with `id`,
/// `url`, and a `fields` map) into normalized work items. All ADO items land in "Assigned".
pub fn parse_ado_items(json: &str) -> Vec<WorkItem> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let id_num = row.get("id").and_then(|v| v.as_u64())?;
            let fields = row.get("fields");
            let field = |name: &str| {
                fields
                    .and_then(|f| f.get(name))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            };
            let title = field("System.Title").unwrap_or_default();
            let state = field("System.State").unwrap_or_else(|| "Active".to_string());
            let repository = field("System.TeamProject").unwrap_or_default();
            // Derive the human edit URL from the work item's REST `url`, when present.
            let api_url = row.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let url = ado_html_url(api_url, id_num);
            Some(WorkItem {
                id: format!("ado-{id_num}"),
                source: ADO_SOURCE.to_string(),
                kind: WorkItemKind::WorkItem,
                category: "Assigned".to_string(),
                title,
                repository,
                url,
                state,
                number: Some(id_num),
                updated_at: None,
                labels: Vec::new(),
            })
        })
        .collect()
}

/// Turn a work item's REST API url into the browser edit url. ADO REST urls look like
/// `https://dev.azure.com/{org}/{proj}/_apis/wit/workItems/{id}`; the edit page swaps the
/// `_apis/wit/workItems/` segment for `_workitems/edit/`. Falls back to empty when not derivable.
fn ado_html_url(api_url: &str, id: u64) -> String {
    if let Some((base, _)) = api_url.split_once("/_apis/wit/workItems/") {
        return format!("{base}/_workitems/edit/{id}");
    }
    String::new()
}

/// Best-effort: PRs in the configured ADO project awaiting the signed-in user's review (the
/// "PR put up for you" source for ADO). Returns an empty vec on any failure — no signed-in
/// user, no default project, or a CLI error — so the assigned work items still surface.
fn fetch_ado_review_prs() -> Vec<WorkItem> {
    let Some(user) = signed_in_user() else {
        return Vec::new();
    };
    match run_az(&[
        "repos",
        "pr",
        "list",
        "--reviewer",
        &user,
        "--status",
        "active",
        "-o",
        "json",
    ]) {
        Ok(json) => parse_ado_prs(&json),
        Err(_) => Vec::new(),
    }
}

/// Resolve the signed-in user's principal name (for the PR `--reviewer` filter). `None` on any
/// failure (e.g. missing Microsoft Graph permission), which simply disables the PR query.
fn signed_in_user() -> Option<String> {
    let output = Command::new("az")
        .args([
            "ad",
            "signed-in-user",
            "show",
            "--query",
            "userPrincipalName",
            "-o",
            "tsv",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let upn = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if upn.is_empty() {
        None
    } else {
        Some(upn)
    }
}

/// Run a generic `az <args>` returning stdout, or a short sanitized error.
fn run_az(args: &[&str]) -> Result<String, String> {
    let output = Command::new("az")
        .args(args)
        .output()
        .map_err(|_| "could not run the Azure CLI".to_string())?;
    if !output.status.success() {
        return Err("the Azure CLI returned an error".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse `az repos pr list -o json` into normalized review-requested PR work items. The browser
/// URL is derived from the repository web URL + the PR id when present.
pub fn parse_ado_prs(json: &str) -> Vec<WorkItem> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let id = row.get("pullRequestId").and_then(|v| v.as_u64())?;
            let title = row
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let repository = row.get("repository");
            let repo_name = repository
                .and_then(|r| r.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let project = repository
                .and_then(|r| r.get("project"))
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let web_url = repository
                .and_then(|r| r.get("webUrl"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let url = if web_url.is_empty() {
                String::new()
            } else {
                format!("{web_url}/pullrequest/{id}")
            };
            let state = row
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("active")
                .to_string();
            let repository_label = if project.is_empty() {
                repo_name.to_string()
            } else {
                format!("{project}/{repo_name}")
            };
            Some(WorkItem {
                id: format!("ado-pr-{id}"),
                source: ADO_SOURCE.to_string(),
                kind: WorkItemKind::PullRequest,
                category: "Review requested".to_string(),
                title,
                repository: repository_label,
                url,
                state,
                number: Some(id),
                updated_at: None,
                labels: Vec::new(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_issue_rows() {
        let json = r#"[
            {"number":12,"title":"Fix the thing","repository":{"nameWithOwner":"acme/widgets"},
             "url":"https://github.com/acme/widgets/issues/12","state":"open",
             "updatedAt":"2026-06-14T10:00:00Z","labels":[{"name":"bug"},{"name":"p1"}]},
            {"number":13,"title":"No url dropped","repository":{"nameWithOwner":"acme/widgets"},
             "url":"","state":"open"}
        ]"#;
        let items = parse_github_items(json, WorkItemKind::Issue, "Assigned");
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, WorkItemKind::Issue);
        assert_eq!(item.category, "Assigned");
        assert_eq!(item.repository, "acme/widgets");
        assert_eq!(item.number, Some(12));
        assert_eq!(item.labels, vec!["bug".to_string(), "p1".to_string()]);
    }

    #[test]
    fn parse_tolerates_garbage_and_non_arrays() {
        assert!(parse_github_items("not json", WorkItemKind::Issue, "Assigned").is_empty());
        assert!(parse_github_items("{}", WorkItemKind::PullRequest, "Authored").is_empty());
    }

    #[test]
    fn dedup_keeps_first_category() {
        let mut items = vec![
            WorkItem {
                id: "u1".to_string(),
                source: GITHUB_SOURCE.to_string(),
                kind: WorkItemKind::PullRequest,
                category: "Authored".to_string(),
                title: "PR".to_string(),
                repository: "a/b".to_string(),
                url: "u1".to_string(),
                state: "open".to_string(),
                number: Some(1),
                updated_at: None,
                labels: vec![],
            },
            WorkItem {
                id: "u1".to_string(),
                source: GITHUB_SOURCE.to_string(),
                kind: WorkItemKind::PullRequest,
                category: "Review requested".to_string(),
                title: "PR".to_string(),
                repository: "a/b".to_string(),
                url: "u1".to_string(),
                state: "open".to_string(),
                number: Some(1),
                updated_at: None,
                labels: vec![],
            },
        ];
        dedup_by_id(&mut items);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].category, "Authored");
    }

    #[test]
    fn snapshot_ignores_unknown_sources() {
        let snap = snapshot(&["totally-unknown".to_string()]);
        assert!(snap.sources.is_empty());
    }

    #[test]
    fn parses_ado_work_item_rows() {
        let json = r#"[
            {"id":501,"url":"https://dev.azure.com/honeydrunk/proj/_apis/wit/workItems/501",
             "fields":{"System.Title":"Ship the hub","System.State":"Active",
                       "System.WorkItemType":"User Story","System.TeamProject":"HoneyHub"}},
            {"fields":{"System.Title":"no id dropped"}}
        ]"#;
        let items = parse_ado_items(json);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, WorkItemKind::WorkItem);
        assert_eq!(item.category, "Assigned");
        assert_eq!(item.repository, "HoneyHub");
        assert_eq!(item.state, "Active");
        assert_eq!(item.number, Some(501));
        assert_eq!(item.id, "ado-501");
        assert_eq!(
            item.url,
            "https://dev.azure.com/honeydrunk/proj/_workitems/edit/501"
        );
    }

    #[test]
    fn parses_ado_pr_rows() {
        let json = r#"[
            {"pullRequestId":42,"title":"Add the thing","status":"active",
             "repository":{"name":"widgets","webUrl":"https://dev.azure.com/org/proj/_git/widgets",
                           "project":{"name":"proj"}}},
            {"title":"no id dropped"}
        ]"#;
        let items = parse_ado_prs(json);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.kind, WorkItemKind::PullRequest);
        assert_eq!(item.category, "Review requested");
        assert_eq!(item.id, "ado-pr-42");
        assert_eq!(item.repository, "proj/widgets");
        assert_eq!(
            item.url,
            "https://dev.azure.com/org/proj/_git/widgets/pullrequest/42"
        );
    }

    #[test]
    fn ado_html_url_falls_back_when_not_derivable() {
        assert_eq!(ado_html_url("", 9), "");
        assert_eq!(
            ado_html_url("https://dev.azure.com/org/p/_apis/wit/workItems/7", 7),
            "https://dev.azure.com/org/p/_workitems/edit/7"
        );
    }
}
