#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchArtifact {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: ArtifactKind,
    pub label: String,
    pub href: Option<String>,
    pub repo_relative_path: Option<String>,
    pub created_at: String,
}
