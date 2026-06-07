use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Branch,
    Commit,
    PullRequest,
    IssuePacket,
    AdrDraft,
    PdrDraft,
    Report,
    LogBundle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchArtifact {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: ArtifactKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_relative_path: Option<String>,
    pub created_at: String,
}
