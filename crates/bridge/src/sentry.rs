//! **Sentry** observability connector (opt-in, read-only): the unresolved error issues for a
//! project, so the cockpit can surface "what's broken" next to traces (Grafana) and queues
//! (Service Bus). Config (base URL, org, project, API token) is held in the cockpit and passed
//! per-request — never persisted here. Read-only: it only GETs the issues list. Dependency-free
//! — it shells `curl`, like the other connectors. Defaults to `https://sentry.io` when no base
//! URL is given (self-hosted Sentry sets its own).

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryIssue {
    pub id: String,
    /// Short human id like `PROJECT-1A2`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub culprit: Option<String>,
    /// `error` / `warning` / `fatal` / `info`.
    pub level: String,
    /// Event count for the issue (Sentry returns this as a string).
    pub count: i64,
    pub user_count: i64,
    pub permalink: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentrySummary {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub issues: Vec<SentryIssue>,
}

const DEFAULT_BASE: &str = "https://sentry.io";

/// Summarize a Sentry project's unresolved issues, read-only. `org`/`project`/`token` are
/// required (empty → "not configured"); `base_url` defaults to sentry.io for SaaS. An
/// unreachable host / bad token returns an unavailable summary with a short hint.
pub fn summary(base_url: &str, org: &str, project: &str, token: &str) -> SentrySummary {
    let org = org.trim();
    let project = project.trim();
    let token = token.trim();
    if org.is_empty() || project.is_empty() || token.is_empty() {
        return unavailable("not configured — add your Sentry org, project, and token in Settings");
    }
    let base = {
        let trimmed = base_url.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            DEFAULT_BASE.to_string()
        } else {
            trimmed.to_string()
        }
    };
    let path =
        format!("/api/0/projects/{org}/{project}/issues/?query=is:unresolved&statsPeriod=24h");
    match curl_get(&base, &path, token) {
        Ok(json) => SentrySummary {
            available: true,
            error: None,
            issues: parse_issues(&json),
        },
        Err(error) => unavailable(&error),
    }
}

fn unavailable(error: &str) -> SentrySummary {
    SentrySummary {
        available: false,
        error: Some(error.to_string()),
        issues: Vec::new(),
    }
}

/// GET `<base><path>` via curl with a bearer token; maps curl exit codes to short hints.
fn curl_get(base: &str, path: &str, token: &str) -> Result<String, String> {
    let url = format!("{base}{path}");
    let output = Command::new("curl")
        .args([
            "-fsS",
            "--max-time",
            "12",
            "-H",
            &format!("Authorization: Bearer {token}"),
            &url,
        ])
        .output()
        .map_err(|_| "curl is not available to reach Sentry".to_string())?;
    if !output.status.success() {
        return Err(match output.status.code() {
            Some(6) | Some(7) => "could not reach Sentry (check the base URL)".to_string(),
            Some(22) => "Sentry rejected the request (check the token / org / project)".to_string(),
            Some(28) => "Sentry timed out".to_string(),
            _ => "could not read Sentry".to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse the Sentry issues list (a JSON array). `count` arrives as a string; `userCount` as a
/// number — both are normalized to i64.
pub fn parse_issues(json: &str) -> Vec<SentryIssue> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let title = row
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let opt_str = |key: &str| {
                row.get(key)
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
            };
            Some(SentryIssue {
                id,
                short_id: opt_str("shortId"),
                title,
                culprit: opt_str("culprit"),
                level: row
                    .get("level")
                    .and_then(|v| v.as_str())
                    .unwrap_or("error")
                    .to_string(),
                count: as_i64(row.get("count")),
                user_count: as_i64(row.get("userCount")),
                permalink: opt_str("permalink").unwrap_or_default(),
                last_seen: opt_str("lastSeen"),
            })
        })
        .collect()
}

/// Coerce a JSON value that may be a number OR a numeric string into i64 (Sentry's `count`).
fn as_i64(value: Option<&serde_json::Value>) -> i64 {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_is_not_configured() {
        let result = summary("", "", "", "");
        assert!(!result.available);
        assert!(result.error.unwrap().contains("not configured"));
        // Missing any one required field → still not configured.
        assert!(!summary("", "org", "proj", "").available);
    }

    #[test]
    fn parses_issues_with_string_count() {
        let json = r#"[
            {"id":"100","shortId":"HD-1","title":"NullRef in handler","culprit":"handler.rs",
             "level":"error","count":"42","userCount":7,
             "permalink":"https://sentry.io/organizations/hd/issues/100/","lastSeen":"2026-06-14T20:00:00Z"},
            {"title":"no id dropped"}
        ]"#;
        let issues = parse_issues(json);
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.short_id.as_deref(), Some("HD-1"));
        assert_eq!(issue.count, 42); // string → i64
        assert_eq!(issue.user_count, 7);
        assert_eq!(issue.level, "error");
        assert!(issue.permalink.contains("issues/100"));
    }

    #[test]
    fn parse_tolerates_garbage() {
        assert!(parse_issues("not json").is_empty());
        assert!(parse_issues("{}").is_empty());
    }

    #[test]
    fn as_i64_handles_number_and_string() {
        assert_eq!(as_i64(Some(&serde_json::json!(5))), 5);
        assert_eq!(as_i64(Some(&serde_json::json!("9"))), 9);
        assert_eq!(as_i64(Some(&serde_json::json!("x"))), 0);
        assert_eq!(as_i64(None), 0);
    }
}
