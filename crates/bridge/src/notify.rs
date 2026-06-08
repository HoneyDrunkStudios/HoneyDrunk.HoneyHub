//! State-only notification seam (ADR-0090 D7 `[Firm]`).
//!
//! A [`Notification`] carries **status / backend / repo / link only** — by
//! construction it has no field for prompt text, code, secrets, stack traces, or
//! full paths, so a transport cannot leak them. Notifications fire on
//! `needs_input` / `completed` / `failed` / `cancelled` (run-state transitions)
//! and `PR opened`.
//!
//! `PR opened` ownership (ADR-0090 / packet 06 split): the **adapter** detects a
//! PR open and persists it as a PR-kind `DispatchArtifact`; this seam fires the
//! `PR opened` notification by observing that **new PR-artifact row landing** —
//! it never re-parses CLI output. One detector, one notifier.
//!
//! The transport is deliberately abstract (`Notifier`): Phase 2 uses the in-app
//! [`NotificationCenter`]; richer transports (web push, Discord/ADR-0084) are an
//! additive later seam.

use crate::adapter::AgentBackend;
use crate::artifact::{ArtifactKind, DispatchArtifact};
use crate::session::DispatchRunState;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    NeedsInput,
    Completed,
    Failed,
    Cancelled,
    PrOpened,
}

/// A state-only notification. The fields are intentionally limited to
/// status/backend/repo/link (ADR-0090 D7); there is nowhere to put transcript or
/// path content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: NotificationKind,
    pub session_id: String,
    pub run_id: String,
    pub backend: AgentBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    pub created_at: String,
}

/// The state-only context a run-state notification is built from. Grouping these
/// keeps the emission site to status/backend/repo/link and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunNotificationContext {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub backend: AgentBackend,
    pub repo: Option<String>,
    pub link: Option<String>,
    pub created_at: String,
}

/// Map a run-state transition to a notification, if that state is notify-worthy.
/// `running`/`finalizing`/intermediate states produce nothing.
pub fn notification_for_state(
    context: RunNotificationContext,
    state: &DispatchRunState,
) -> Option<Notification> {
    let kind = match state {
        DispatchRunState::NeedsInput => NotificationKind::NeedsInput,
        DispatchRunState::Completed => NotificationKind::Completed,
        DispatchRunState::Failed => NotificationKind::Failed,
        DispatchRunState::Cancelled => NotificationKind::Cancelled,
        _ => return None,
    };
    Some(Notification {
        id: context.id,
        kind,
        session_id: context.session_id,
        run_id: context.run_id,
        backend: context.backend,
        repo: context.repo,
        link: context.link,
        created_at: context.created_at,
    })
}

/// Fire a `PR opened` notification when a newly persisted artifact is a pull
/// request. Other artifact kinds produce nothing. The link is the PR href; no
/// path or content is carried.
pub fn notification_for_artifact(
    id: impl Into<String>,
    backend: AgentBackend,
    artifact: &DispatchArtifact,
    created_at: impl Into<String>,
) -> Option<Notification> {
    if artifact.kind != ArtifactKind::PullRequest {
        return None;
    }
    Some(Notification {
        id: id.into(),
        kind: NotificationKind::PrOpened,
        session_id: artifact.session_id.clone(),
        run_id: artifact.run_id.clone(),
        backend,
        repo: None,
        link: artifact.href.clone(),
        created_at: created_at.into(),
    })
}

/// The Phase 2 in-app transport: collect notifications for the PWA to surface as
/// a list/badge. A later transport implements the same intent without changing
/// the emission sites.
pub trait Notifier {
    fn notify(&self, notification: Notification);
}

#[derive(Debug, Default)]
pub struct NotificationCenter {
    notifications: Mutex<Vec<Notification>>,
}

impl NotificationCenter {
    pub fn new() -> Self {
        Self::default()
    }

    /// A snapshot of collected notifications (oldest first).
    pub fn snapshot(&self) -> Vec<Notification> {
        self.notifications
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.notifications
            .lock()
            .map(|guard| guard.len())
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Notifier for NotificationCenter {
    fn notify(&self, notification: Notification) {
        if let Ok(mut guard) = self.notifications.lock() {
            guard.push(notification);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn context() -> RunNotificationContext {
        RunNotificationContext {
            id: "n".to_string(),
            session_id: "s".to_string(),
            run_id: "r".to_string(),
            backend: AgentBackend::ClaudeLocal,
            repo: Some("HoneyDrunk.HoneyHub".to_string()),
            link: None,
            created_at: "2026-06-07T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn notifies_only_on_terminal_or_needs_input_states() {
        let notify = |state| notification_for_state(context(), &state);
        assert_eq!(
            notify(DispatchRunState::NeedsInput).map(|n| n.kind),
            Some(NotificationKind::NeedsInput)
        );
        assert_eq!(
            notify(DispatchRunState::Completed).map(|n| n.kind),
            Some(NotificationKind::Completed)
        );
        assert_eq!(
            notify(DispatchRunState::Failed).map(|n| n.kind),
            Some(NotificationKind::Failed)
        );
        assert_eq!(
            notify(DispatchRunState::Cancelled).map(|n| n.kind),
            Some(NotificationKind::Cancelled)
        );
        assert!(notify(DispatchRunState::Running).is_none());
        assert!(notify(DispatchRunState::Finalizing).is_none());
        assert!(notify(DispatchRunState::Starting).is_none());
    }

    #[test]
    fn pr_opened_fires_only_for_pull_request_artifacts() {
        let artifact = |kind| DispatchArtifact {
            id: "a".to_string(),
            session_id: "s".to_string(),
            run_id: "r".to_string(),
            kind,
            label: "x".to_string(),
            href: Some("https://example.test/pr/1".to_string()),
            repo_relative_path: Some("crates/bridge".to_string()),
            created_at: "2026-06-07T12:00:00Z".to_string(),
        };
        let pr = notification_for_artifact(
            "n",
            AgentBackend::ClaudeLocal,
            &artifact(ArtifactKind::PullRequest),
            "2026-06-07T12:00:00Z",
        )
        .expect("pr fires");
        assert_eq!(pr.kind, NotificationKind::PrOpened);
        assert_eq!(pr.link.as_deref(), Some("https://example.test/pr/1"));
        assert!(notification_for_artifact(
            "n",
            AgentBackend::ClaudeLocal,
            &artifact(ArtifactKind::Branch),
            "2026-06-07T12:00:00Z",
        )
        .is_none());
    }

    #[test]
    fn notification_payload_carries_no_sensitive_fields() {
        // The PR artifact has a repo-relative path; the notification must not carry
        // it (or any body/task/prompt/secret) — only status/backend/repo/link.
        let artifact = DispatchArtifact {
            id: "a".to_string(),
            session_id: "s".to_string(),
            run_id: "r".to_string(),
            kind: ArtifactKind::PullRequest,
            label: "secret-branch-name".to_string(),
            href: Some("https://example.test/pr/1".to_string()),
            repo_relative_path: Some("crates/bridge/secret.rs".to_string()),
            created_at: "2026-06-07T12:00:00Z".to_string(),
        };
        let notification = notification_for_artifact(
            "n",
            AgentBackend::ClaudeLocal,
            &artifact,
            "2026-06-07T12:00:00Z",
        )
        .expect("fires");
        let value = serde_json::to_value(&notification).expect("serializes");
        let object = value.as_object().expect("is object");
        let allowed = [
            "id",
            "kind",
            "sessionId",
            "runId",
            "backend",
            "repo",
            "link",
            "createdAt",
        ];
        for key in object.keys() {
            assert!(allowed.contains(&key.as_str()), "unexpected field: {key}");
        }
        // No path/label content leaked anywhere in the payload.
        let serialized = serde_json::to_string(&notification).expect("string");
        assert!(!serialized.contains("secret.rs"));
        assert!(!serialized.contains("secret-branch-name"));
        assert!(matches!(object.get("repo"), None | Some(Value::Null)));
    }

    #[test]
    fn notification_center_collects() {
        let center = NotificationCenter::new();
        assert!(center.is_empty());
        center.notify(
            notification_for_state(context(), &DispatchRunState::Completed).expect("fires"),
        );
        assert_eq!(center.len(), 1);
        assert_eq!(center.snapshot()[0].kind, NotificationKind::Completed);
    }
}
