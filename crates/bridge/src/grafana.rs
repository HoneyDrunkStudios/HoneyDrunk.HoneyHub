//! **Grafana** observability connector (opt-in, read-only): a thin native summary over a
//! Grafana instance — its health (version / database) and its dashboards as deep-links — so
//! the cockpit can surface Pulse telemetry (Tempo traces, Mimir metrics, Loki logs) and hand
//! off to Grafana for the deep view. The operator points it at a base URL + API token (held
//! locally in the cockpit, passed to the host per-request, never persisted here). Read-only:
//! it only GETs `/api/health` and `/api/search`. Dependency-free — it shells `curl` (present
//! on Windows 10+/macOS/Linux), matching the rest of the bridge's connectors.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboard {
    pub title: String,
    pub uid: String,
    /// Absolute browser URL to open the dashboard.
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaSummary {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The Grafana base URL the summary is for (echoed so the UI can build deep-links).
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    pub dashboards: Vec<GrafanaDashboard>,
}

/// Summarize a Grafana instance: health + dashboard list, read-only. `base_url` empty =
/// "not configured"; an unreachable host / bad token returns an unavailable summary with a
/// short hint (never the raw curl error). `token` may be empty (anonymous Grafana).
pub fn summary(base_url: &str, token: &str) -> GrafanaSummary {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return unavailable(
            &base,
            "not configured — add your Grafana base URL in Settings",
        );
    }
    let health_json = match curl_get(&base, "/api/health", token) {
        Ok(json) => json,
        Err(error) => return unavailable(&base, &error),
    };
    let (version, database) = parse_health(&health_json);
    let dashboards = match curl_get(&base, "/api/search?type=dash-db&limit=100", token) {
        Ok(json) => parse_dashboards(&json, &base),
        // Health worked but search didn't — still "available", just no dashboards listed.
        Err(_) => Vec::new(),
    };
    GrafanaSummary {
        available: true,
        error: None,
        base_url: base,
        version,
        database,
        dashboards,
    }
}

fn unavailable(base_url: &str, error: &str) -> GrafanaSummary {
    GrafanaSummary {
        available: false,
        error: Some(error.to_string()),
        base_url: base_url.to_string(),
        version: None,
        database: None,
        dashboards: Vec::new(),
    }
}

/// GET `<base><path>` via curl with an optional bearer token. Maps curl's exit code to a
/// short, non-leaking hint so the UI can tell "unreachable" from "rejected".
fn curl_get(base: &str, path: &str, token: &str) -> Result<String, String> {
    let url = format!("{base}{path}");
    let mut command = Command::new("curl");
    command.args(["-fsS", "--max-time", "12"]);
    if !token.trim().is_empty() {
        command.args(["-H", &format!("Authorization: Bearer {}", token.trim())]);
    }
    command.arg(&url);
    let output = command
        .output()
        .map_err(|_| "curl is not available to reach Grafana".to_string())?;
    if !output.status.success() {
        return Err(match output.status.code() {
            Some(6) | Some(7) => "could not reach Grafana (check the base URL)".to_string(),
            Some(22) => "Grafana rejected the request (check the API token)".to_string(),
            Some(28) => "Grafana timed out".to_string(),
            _ => "could not read Grafana".to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse `/api/health` → `(version?, database?)`.
pub fn parse_health(json: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return (None, None);
    };
    let str_field = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    (str_field("version"), str_field("database"))
}

/// Parse `/api/search?type=dash-db` → dashboards with absolute URLs. The search `url` field is
/// a site-relative path (`/d/<uid>/<slug>`); we join it onto the base.
pub fn parse_dashboards(json: &str, base: &str) -> Vec<GrafanaDashboard> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let title = row.get("title")?.as_str()?.to_string();
            let uid = row
                .get("uid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let rel = row.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let url = if rel.is_empty() {
                format!("{base}/d/{uid}")
            } else if rel.starts_with("http") {
                rel.to_string()
            } else {
                format!("{base}{rel}")
            };
            let folder = row
                .get("folderTitle")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            Some(GrafanaDashboard {
                title,
                uid,
                url,
                folder,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_base_is_not_configured() {
        let summary = summary("", "");
        assert!(!summary.available);
        assert!(summary.error.unwrap().contains("not configured"));
    }

    #[test]
    fn parses_health_fields() {
        let (version, database) =
            parse_health(r#"{"commit":"abc","database":"ok","version":"10.4.2"}"#);
        assert_eq!(version.as_deref(), Some("10.4.2"));
        assert_eq!(database.as_deref(), Some("ok"));
        assert_eq!(parse_health("nope"), (None, None));
    }

    #[test]
    fn parses_dashboards_joining_relative_urls() {
        let json = r#"[
            {"uid":"abc","title":"Pulse Overview","url":"/d/abc/pulse-overview","folderTitle":"Pulse"},
            {"uid":"def","title":"No URL"}
        ]"#;
        let dashboards = parse_dashboards(json, "https://grafana.example.com");
        assert_eq!(dashboards.len(), 2);
        assert_eq!(
            dashboards[0].url,
            "https://grafana.example.com/d/abc/pulse-overview"
        );
        assert_eq!(dashboards[0].folder.as_deref(), Some("Pulse"));
        // Missing url → derived from uid.
        assert_eq!(dashboards[1].url, "https://grafana.example.com/d/def");
    }

    #[test]
    fn parse_dashboards_tolerates_garbage() {
        assert!(parse_dashboards("not json", "https://x").is_empty());
        assert!(parse_dashboards("{}", "https://x").is_empty());
    }
}
