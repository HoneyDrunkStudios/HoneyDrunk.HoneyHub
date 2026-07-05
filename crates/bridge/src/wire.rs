use crate::activity::DispatchActivity;
use crate::adapter::{AgentBackend, BridgeError, StartRunRequest};
use crate::agents::{AgentDefinition, AgentWriteOutcome};
use crate::artifact::DispatchArtifact;
use crate::backend_catalog::BackendCapability;
use crate::checks::CheckOutcome;
use crate::contentsearch::ContentSearchResults;
use crate::environment::EnvironmentInfo;
use crate::fsbrowse::{DirListing, FileContents, FileWriteResult, SearchResults, WorkspaceFolders};
use crate::git::{GitBranches, GitDiff, GitFileVersions, GitOpResult, GitOverview, GitStatus};
use crate::grafana::GrafanaSummary;
use crate::jobs::{JobProbe, JobSnapshot};
use crate::keyvault::{
    AzureSubscriptionList, ExpiringObjects, KeyVaultList, SecretReveal, VaultObjects,
};
use crate::lsp::LspStatus;
use crate::network::NetworkInfo;
use crate::roadmap::RoadmapSnapshot;
use crate::sentry::SentrySummary;
use crate::servicebus::{
    SbEntityProps, ServiceBusEntities, ServiceBusManage, ServiceBusPeek, ServiceBusPurge,
    ServiceBusReceive, ServiceBusResubmit, ServiceBusSend, ServiceBusSnapshot,
};
use crate::session::{
    DispatchControlEvent, DispatchMessage, DispatchRun, DispatchRunState, DispatchSession,
    PolicyHint, UsageSignal, UsageSummary,
};
use crate::work::WorkSnapshot;
use serde::{Deserialize, Serialize};

pub const WIRE_PROTOCOL_VERSION: &str = "honeyhub.bridge.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireFrameKind {
    ClientCommand,
    ServerEvent,
    Ack,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFrame {
    pub protocol: String,
    pub frame_id: String,
    pub kind: WireFrameKind,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<ClientCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<BridgeEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BridgeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ack_frame_id: Option<String>,
}

impl WireFrame {
    pub fn server_event(
        frame_id: impl Into<String>,
        event: BridgeEvent,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::ServerEvent,
            created_at: created_at.into(),
            command: None,
            event: Some(event),
            error: None,
            ack_frame_id: None,
        }
    }

    pub fn client_command(
        frame_id: impl Into<String>,
        command: ClientCommand,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::ClientCommand,
            created_at: created_at.into(),
            command: Some(command),
            event: None,
            error: None,
            ack_frame_id: None,
        }
    }

    pub fn ack(
        frame_id: impl Into<String>,
        ack_frame_id: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::Ack,
            created_at: created_at.into(),
            command: None,
            event: None,
            error: None,
            ack_frame_id: Some(ack_frame_id.into()),
        }
    }

    pub fn error(
        frame_id: impl Into<String>,
        error: BridgeError,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            protocol: WIRE_PROTOCOL_VERSION.to_string(),
            frame_id: frame_id.into(),
            kind: WireFrameKind::Error,
            created_at: created_at.into(),
            command: None,
            event: None,
            error: Some(error),
            ack_frame_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClientCommand {
    Start {
        request: Box<StartRunRequest>,
    },
    Reply {
        run_id: String,
        text: String,
    },
    Stop {
        run_id: String,
    },
    Resume {
        session_id_or_transcript: String,
    },
    Reconnect {
        request: ReconnectRequest,
    },
    /// Request the device-wide "your spend" summary (ADR-0092 D2 cost view). A
    /// read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::UsageSummary`] server event followed by an ack.
    UsageSummary,
    /// Request the cross-session coaching advisories (ADR-0092 D4 / packet 09 §3e).
    /// A read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::CoachingHints`] server event followed by an ack.
    CoachingHints,
    /// Discover the user's own agent definitions (packet 09 §3f-bis). `workspace_root`
    /// scopes discovery to one allowlisted root; omitted, every allowlisted root is
    /// scanned. The host answers with a single [`BridgeEventPayload::AgentCatalog`].
    DiscoverAgents {
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_root: Option<String>,
    },
    /// Discover which backend CLIs are installed on this machine and the models they
    /// offer (packet 09 §3 / ADR-0092). The webview cannot probe the host, so it asks
    /// the bridge. A read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::BackendCatalog`].
    DiscoverBackends,
    /// Replace the workspace allowlist with the repo locations the user picked in the
    /// cockpit (packet 09 §3). Scopes file reads — and launches — to those roots. The
    /// host applies it and acks (no event).
    SetWorkspaceRoots {
        roots: Vec<String>,
    },
    /// Browse a directory for the repo/file picker (read-only, names + kinds only, no
    /// contents). An omitted/empty `path` returns the top level (drive roots on
    /// Windows, `/` on Unix). The host answers with a [`BridgeEventPayload::DirListing`].
    BrowseDir {
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// Read a file's UTF-8 text for the viewer (read-only). The host gates `path`
    /// against the workspace allowlist and answers with a
    /// [`BridgeEventPayload::FileContents`] (or an error for binary/oversized/denied).
    ReadFile {
        path: String,
    },
    /// Write a file's full UTF-8 text (the in-app editor's Save). The host gates the
    /// target against the workspace allowlist (the target itself when it exists, else its
    /// parent directory for a new file) and answers with a
    /// [`BridgeEventPayload::FileWritten`] result.
    WriteFile {
        path: String,
        content: String,
    },
    /// Recursively search a root for files whose name contains `query` (read-only).
    /// The host gates `root` against the allowlist and answers with a
    /// [`BridgeEventPayload::SearchResults`].
    SearchFiles {
        root: String,
        query: String,
    },
    /// Repo-wide **content** search (VS Code's "Find in Files"): grep the files under `root` for
    /// `query`, read-only. `case_sensitive`/`whole_word`/`is_regex` are optional flags (all
    /// default off). The host gates `root` against the workspace allowlist and answers with a
    /// [`BridgeEventPayload::ContentSearchResults`] (matches, capped + truncation-flagged, plus the
    /// engine used). All three flag fields default so an older client that omits them still parses.
    SearchContent {
        root: String,
        query: String,
        #[serde(default)]
        case_sensitive: bool,
        #[serde(default)]
        whole_word: bool,
        #[serde(default)]
        is_regex: bool,
    },
    /// Resolve a VS Code `.code-workspace` file to the repo folders it references, so
    /// the picker can add several repos at once. Read-only; answered with a
    /// [`BridgeEventPayload::WorkspaceFolders`].
    ResolveWorkspaceFile {
        path: String,
    },
    /// Author a Claude agent definition (packet 09 §3d — make agents in-app). Writes
    /// `<root>/.claude/agents/<name>.md`; an omitted `workspace_root` targets the user's
    /// global `~/.claude/agents`. The host gates a project `workspace_root` against the
    /// allowlist and answers with a [`BridgeEventPayload::AgentWritten`], then the UI
    /// re-discovers. `model` is an optional default model for the agent's frontmatter.
    WriteAgent {
        name: String,
        description: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_root: Option<String>,
    },
    /// Snapshot the local processes + curated known-job health (control-hub roadmap #7).
    /// A read-only query; the host merges the user's `extra_probes` /
    /// `extra_task_keywords` (configurable job patterns) onto the built-in set and answers
    /// with a single [`BridgeEventPayload::JobSnapshot`]. Both default to empty.
    ListJobs {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra_probes: Vec<JobProbe>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        extra_task_keywords: Vec<String>,
    },
    /// Detect each backend CLI's installed version (control-hub roadmap #8). A read-only
    /// query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::EnvironmentInfo`].
    DetectEnvironment,
    /// List this host's reachable (non-loopback) addresses for **mobile pairing** ("Connect
    /// a phone"). A read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::NetworkInfo`].
    ListNetwork,
    /// Fetch work items from the opt-in **work connectors** the cockpit has enabled (by id,
    /// e.g. `github`). Read-only; the host queries ONLY the listed `sources` and answers with
    /// a single [`BridgeEventPayload::WorkSnapshot`]. Empty `sources` = query nothing.
    ListWork {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        sources: Vec<String>,
    },
    /// Snapshot Azure Service Bus (opt-in observability connector): namespaces + queue /
    /// subscription message counts. Read-only (management plane only); the host answers with
    /// a single [`BridgeEventPayload::ServiceBusSnapshot`].
    ListServiceBus,
    /// Browse (non-destructive peek) messages from a Service Bus queue, or a topic
    /// subscription when `subscription` is set; `dead_letter` peeks the dead-letter sub-queue.
    /// Read-only data-plane (ADR-0094 D5) via the optional explorer helper; the host answers
    /// with a single [`BridgeEventPayload::ServiceBusPeek`].
    PeekServiceBus {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subscription: Option<String>,
        #[serde(default)]
        dead_letter: bool,
        #[serde(default)]
        count: u32,
    },
    /// **Write op** (ADR-0094 D5): move up to `count` dead-letter messages of a queue (or topic
    /// subscription) back to the source. Destructive; the cockpit gates it behind an explicit
    /// confirmation. The host answers with a single [`BridgeEventPayload::ServiceBusResubmit`].
    ResubmitDeadLetter {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subscription: Option<String>,
        #[serde(default)]
        count: u32,
    },
    /// **Write op** (ADR-0094 D5): drain ALL messages from a queue / subscription (or its
    /// dead-letter sub-queue). Irreversibly destructive; the cockpit gates it behind an
    /// explicit confirmation. The host answers with [`BridgeEventPayload::ServiceBusPurge`].
    PurgeServiceBus {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subscription: Option<String>,
        #[serde(default)]
        dead_letter: bool,
    },
    /// **Write op** (ADR-0094 D5): publish a message to a queue / topic. The cockpit gates it
    /// behind an explicit confirmation. The host answers with
    /// [`BridgeEventPayload::ServiceBusSend`].
    SendServiceBus {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        entity: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
    /// **Write op** (ADR-0094 D5): consume + remove the next single message from a queue /
    /// subscription (or its dead-letter sub-queue). Destructive; confirmation-gated. The host
    /// answers with [`BridgeEventPayload::ServiceBusReceive`].
    ReceiveServiceBus {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subscription: Option<String>,
        #[serde(default)]
        dead_letter: bool,
    },
    /// List a connection's namespace entities (queues + topics + subscriptions, with counts +
    /// editable properties) via the admin client. The host answers with
    /// [`BridgeEventPayload::ServiceBusEntities`].
    ListServiceBusEntities {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
    },
    /// **Write op** (ADR-0094 D5): create/delete/update a queue/topic/subscription. `op` ∈
    /// {create,delete,update}, `kind` ∈ {queue,topic,subscription}. Confirmation-gated. The host
    /// answers with [`BridgeEventPayload::ServiceBusManage`].
    ManageServiceBus {
        namespace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_string: Option<String>,
        op: String,
        entity_kind: String,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subscription: Option<String>,
        #[serde(default)]
        props: SbEntityProps,
    },
    /// List the operator's Azure subscriptions (`az account list`) for the **Key Vault**
    /// connector's subscription picker. Read-only; the host answers with a single
    /// [`BridgeEventPayload::AzureSubscriptions`].
    ListAzureSubscriptions,
    /// Snapshot the Key Vaults across the selected `subscription_ids` (`az keyvault list`), for
    /// the opt-in **Key Vault** connector. Read-only (management plane only); the host answers
    /// with a single [`BridgeEventPayload::KeyVaults`]. Empty `subscription_ids` = query nothing.
    ListKeyVaults {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        subscription_ids: Vec<String>,
    },
    /// List one vault's secrets / keys / certificates (metadata only, never values) for the
    /// **Key Vault** connector, when the cockpit expands that vault. Read-only data plane; the host
    /// answers with a single [`BridgeEventPayload::VaultObjects`].
    ListVaultObjects {
        vault: String,
        subscription_id: String,
    },
    /// Reveal a single secret's value (the gated "view it" action). Read-only data plane; the host
    /// answers with a single [`BridgeEventPayload::SecretReveal`]. The value is sensitive and rides
    /// the local bridge on demand only, never persisted host-side.
    RevealSecret {
        vault: String,
        subscription_id: String,
        name: String,
    },
    /// Scan the selected subscriptions' vaults for objects that carry an expiry, for the **Key
    /// Vault** connector's background expiry notifications. Read-only data plane; the host answers
    /// with a single [`BridgeEventPayload::KeyVaultExpiry`]. Empty `subscription_ids` = scan nothing.
    ScanKeyVaultExpiry {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        subscription_ids: Vec<String>,
    },
    /// Summarize a Grafana instance (opt-in observability connector): health + dashboards.
    /// The config (`base_url` + optional `token`) is held in the cockpit and passed per
    /// request — the host doesn't persist it. Read-only; the host answers with a single
    /// [`BridgeEventPayload::GrafanaSummary`].
    GrafanaSummary {
        base_url: String,
        #[serde(default)]
        token: String,
    },
    /// Summarize a Sentry project's unresolved issues (opt-in observability connector). Config
    /// (`base_url` + `org` + `project` + `token`) is held in the cockpit and passed per request
    /// — the host doesn't persist it. Read-only; answered with [`BridgeEventPayload::SentrySummary`].
    SentrySummary {
        #[serde(default)]
        base_url: String,
        org: String,
        project: String,
        #[serde(default)]
        token: String,
    },
    /// Read a repo's git status (branch / ahead-behind / dirty files). The host gates
    /// `root` against the allowlist and answers with [`BridgeEventPayload::GitStatus`].
    GitStatus {
        root: String,
    },
    /// Read a repo's read-only unified diff (against `HEAD`), optionally one path. The
    /// host gates `root` against the allowlist and answers with
    /// [`BridgeEventPayload::GitDiff`].
    GitDiff {
        root: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// Read both versions of a single file (its `HEAD` content + working-tree content) for
    /// the side-by-side diff view. `path` is repo-relative (like [`ClientCommand::GitDiff`]).
    /// The host gates `root` against the allowlist and answers with
    /// [`BridgeEventPayload::GitFileVersions`].
    GitFileVersions {
        root: String,
        path: String,
    },
    /// Discover the git repos under a selected folder (or the folder itself when it is a
    /// repo) and read each one's status. The host gates `root` against the allowlist and
    /// answers with [`BridgeEventPayload::GitOverview`]. The multi-repo dashboard.
    GitOverview {
        root: String,
    },
    /// List a repo's local branches + the current one (for the branch switcher). Answers
    /// with [`BridgeEventPayload::GitBranches`].
    GitBranches {
        root: String,
    },
    /// **Write** (confirmation-gated): stage paths (`git add`). `["."]` stages everything.
    /// The host answers with a [`BridgeEventPayload::GitOp`] result and a fresh
    /// [`BridgeEventPayload::GitStatus`].
    GitStage {
        root: String,
        paths: Vec<String>,
    },
    /// **Write**: unstage paths (`git restore --staged`). `["."]` unstages everything.
    GitUnstage {
        root: String,
        paths: Vec<String>,
    },
    /// **Write**: commit the staged changes with a message.
    GitCommit {
        root: String,
        message: String,
    },
    /// **Write**: push the current branch.
    GitPush {
        root: String,
    },
    /// **Write**: fast-forward pull (`git pull --ff-only`).
    GitPull {
        root: String,
    },
    /// **Write**: switch to a branch, optionally creating it.
    GitCheckout {
        root: String,
        name: String,
        #[serde(default)]
        create: bool,
    },
    /// **Write**: discard local changes to paths. `untracked` removes untracked files;
    /// otherwise tracked files are restored to HEAD.
    GitDiscard {
        root: String,
        paths: Vec<String>,
        #[serde(default)]
        untracked: bool,
    },
    /// **Write**: discard ALL local changes (restore tracked + remove untracked).
    GitDiscardAll {
        root: String,
    },
    /// **Write**: delete a local branch (`force` uses `-D`).
    GitDeleteBranch {
        root: String,
        name: String,
        #[serde(default)]
        force: bool,
    },
    /// List the locally-persisted sessions (durable chat history). A read-only query;
    /// the host answers with a single [`BridgeEventPayload::SessionList`].
    ListSessions,
    /// Read one persisted session's runs + transcript, to reopen a past chat. The host
    /// answers with a single [`BridgeEventPayload::SessionDetail`].
    SessionDetail {
        session_id: String,
    },
    /// Rename a persisted session (thread management). The host applies the rename to
    /// its store and answers with a refreshed [`BridgeEventPayload::SessionList`].
    RenameSession {
        session_id: String,
        title: String,
    },
    /// Delete a persisted session (record + transcripts), answering with a refreshed
    /// [`BridgeEventPayload::SessionList`].
    DeleteSession {
        session_id: String,
    },
    /// Pin/unpin a persisted session (sorts first; a pinned session's transcript is
    /// exempt from retention pruning), answering with a refreshed
    /// [`BridgeEventPayload::SessionList`].
    PinSession {
        session_id: String,
        pinned: bool,
    },
    /// Probe one backend's plan-usage meters (the TUI-only `/usage` / `/status`
    /// panels) via a hidden host-owned PTY. Answered with a single
    /// [`BridgeEventPayload::UsageProbe`]; supervised and one-shot (see
    /// `usage_probe` module docs).
    ProbeUsage {
        backend: AgentBackend,
    },
    /// Read the roadmap snapshot from the Architecture repo's `initiatives/current-focus.md`
    /// (control-hub #6). A read-only query carrying no fields; the host answers with a single
    /// [`BridgeEventPayload::Roadmap`] (`found: false` when no repo is present).
    Roadmap,
    /// Scaffold a starter Architecture repo (control-hub #6 — Plan empty-state create). An
    /// omitted `name` defaults to `architecture`; an omitted `location` defaults next to a
    /// workspace root. The host answers with a [`BridgeEventPayload::Roadmap`] of the freshly
    /// created repo (or an error, e.g. `already_exists`).
    ScaffoldArchitecture {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        location: Option<String>,
    },
    /// Fast-forward (`git pull --ff-only`) the Architecture repo, then re-read it. Answers
    /// with a [`BridgeEventPayload::Roadmap`] of the refreshed repo (or a git error).
    PullArchitecture,
    /// **Run**: run a **named, host-owned** check (the repo's build/test) in a repo root —
    /// the "test a change group" action. The client sends only a check id; the host resolves
    /// it against its own definitions (built-ins + `HONEYHUB_EXTRA_CHECKS`) and refuses
    /// anything else, gates `root` against the workspace allowlist, rejects overlapping runs
    /// per root, and kills the process after a timeout. Argv is spawned directly (no shell).
    /// The host answers with a single [`BridgeEventPayload::CheckResult`] carrying an
    /// explicit disposition (ran / denied / spawn_failed / timed_out).
    RunCheck {
        root: String,
        /// The named check id. `alias = "command"` lets a stale pre-rename client
        /// degrade gracefully: its free-text command line arrives here, fails the
        /// id allowlist, and comes back as an explicit `denied` outcome instead of
        /// an opaque bad-frame error.
        #[serde(alias = "command")]
        check: String,
    },
    /// **LSP** (ADR-0102): start (or reuse) an allowlisted language server for
    /// `language_id`, scoped to the allowlisted workspace `root`. The client sends only a
    /// language id; the host resolves it against its own server allowlist (never a command
    /// line), locates the operator-installed binary on `PATH`, and spawns it shell-free in
    /// its own process group. One server per (language, root) is reused across files. The
    /// host answers with a single [`BridgeEventPayload::LspStatus`] (running / installed /
    /// degraded) — an absent server is an honest `installed: false`, not an error (the
    /// cockpit's in-file IntelliSense stays on).
    LspStart {
        root: String,
        language_id: String,
    },
    /// **LSP**: forward one LSP JSON-RPC `message` (request / response / notification) to the
    /// running server for (`language_id`, `root`). The host frames it (Content-Length) and
    /// writes it to the server's stdin; the server's replies arrive asynchronously as
    /// [`BridgeEventPayload::LspMessage`] broadcasts. Acked with no inline event. No running
    /// server for that key answers with an `lsp_not_running` error the client folds into
    /// graceful degradation. The payload is opaque to the bridge — a dumb, host-gated pipe.
    LspSend {
        root: String,
        language_id: String,
        message: serde_json::Value,
    },
    /// **LSP**: stop the language server for (`language_id`, `root`), killing its process
    /// group. Acked.
    LspStop {
        root: String,
        language_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectRequest {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeEvent {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub created_at: String,
    pub payload: BridgeEventPayload,
}

impl BridgeEvent {
    pub fn status(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        status: BridgeStatusEvent,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Status { status },
        }
    }

    pub fn message(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        message: DispatchMessage,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Message { message },
        }
    }

    pub fn control(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        event: DispatchControlEvent,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Control { event },
        }
    }

    pub fn usage(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        signal: UsageSignal,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Usage { signal },
        }
    }

    pub fn policy_hint(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        hint: PolicyHint,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::PolicyHint { hint },
        }
    }

    pub fn artifact(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        artifact: DispatchArtifact,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Artifact { artifact },
        }
    }

    /// A per-run tool/file activity event (what the agent is doing). Scoped to its run +
    /// session like a message; the core re-stamps the sequence.
    pub fn activity(
        id: impl Into<String>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        sequence: u64,
        created_at: impl Into<String>,
        activity: DispatchActivity,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            sequence,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Activity { activity },
        }
    }

    /// A device-wide usage summary event. It is **not** scoped to a single run or
    /// session (it aggregates across all of them), so `session_id`/`run_id` are
    /// empty and `sequence` is `0`; the client dispatches on the payload kind.
    pub fn usage_summary(
        id: impl Into<String>,
        created_at: impl Into<String>,
        summary: UsageSummary,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::UsageSummary { summary },
        }
    }

    /// A device-wide coaching-advisories event. Like the usage summary it spans every
    /// session (each hint carries its own `session_id`), so the envelope's
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn coaching_hints(
        id: impl Into<String>,
        created_at: impl Into<String>,
        hints: Vec<PolicyHint>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::CoachingHints { hints },
        }
    }

    /// A device-wide agent-catalog event (the discovered definitions). Not scoped to a
    /// run or session, so the envelope's `session_id`/`run_id` are empty and
    /// `sequence` is `0`.
    pub fn agent_catalog(
        id: impl Into<String>,
        created_at: impl Into<String>,
        agents: Vec<AgentDefinition>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::AgentCatalog { agents },
        }
    }

    /// A device-wide backend-catalog event (the detected providers + their models).
    /// Not scoped to a run or session, so the envelope's `session_id`/`run_id` are
    /// empty and `sequence` is `0`.
    pub fn backend_catalog(
        id: impl Into<String>,
        created_at: impl Into<String>,
        backends: Vec<BackendCapability>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::BackendCatalog { backends },
        }
    }

    /// A device-wide directory-listing event (the file/repo picker). Not scoped to a
    /// run or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn dir_listing(
        id: impl Into<String>,
        created_at: impl Into<String>,
        listing: DirListing,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::DirListing { listing },
        }
    }

    /// A device-wide file-contents event (the read-only viewer). Not scoped to a run
    /// or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn file_contents(
        id: impl Into<String>,
        created_at: impl Into<String>,
        file: FileContents,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::FileContents { file },
        }
    }

    /// A device-wide file-written event (the in-app editor's Save). Not scoped to a run
    /// or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn file_written(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: FileWriteResult,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::FileWritten { result },
        }
    }

    /// A device-wide file-search-results event. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn search_results(
        id: impl Into<String>,
        created_at: impl Into<String>,
        results: SearchResults,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::SearchResults { results },
        }
    }

    /// A device-wide content-search-results event (repo-wide "Find in Files"). Not scoped to a run
    /// or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn content_search_results(
        id: impl Into<String>,
        created_at: impl Into<String>,
        results: ContentSearchResults,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ContentSearchResults { results },
        }
    }

    /// A device-wide workspace-folders event (a `.code-workspace`'s repo folders). Not
    /// scoped to a run or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn workspace_folders(
        id: impl Into<String>,
        created_at: impl Into<String>,
        folders: WorkspaceFolders,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::WorkspaceFolders { folders },
        }
    }

    /// A device-wide agent-written event (an authored definition). Not scoped to a run or
    /// session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn agent_written(
        id: impl Into<String>,
        created_at: impl Into<String>,
        agent: AgentWriteOutcome,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::AgentWritten { agent },
        }
    }

    /// A device-wide local-jobs snapshot. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn job_snapshot(
        id: impl Into<String>,
        created_at: impl Into<String>,
        snapshot: JobSnapshot,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::JobSnapshot { snapshot },
        }
    }

    /// A device-wide CLI-environment snapshot (installed versions). Not scoped to a run or
    /// session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn environment_info(
        id: impl Into<String>,
        created_at: impl Into<String>,
        environment: EnvironmentInfo,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::EnvironmentInfo { environment },
        }
    }

    /// A device-wide reachable-addresses snapshot (mobile pairing). Not scoped to a run or
    /// session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn network_info(
        id: impl Into<String>,
        created_at: impl Into<String>,
        network: NetworkInfo,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::NetworkInfo { network },
        }
    }

    /// A device-wide work-connectors snapshot. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn work_snapshot(
        id: impl Into<String>,
        created_at: impl Into<String>,
        snapshot: WorkSnapshot,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::WorkSnapshot { snapshot },
        }
    }

    /// A device-wide Service Bus snapshot. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_snapshot(
        id: impl Into<String>,
        created_at: impl Into<String>,
        snapshot: ServiceBusSnapshot,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusSnapshot { snapshot },
        }
    }

    /// A device-wide Azure subscription list (Key Vault connector picker). Not scoped to a run or
    /// session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn azure_subscriptions(
        id: impl Into<String>,
        created_at: impl Into<String>,
        subscriptions: AzureSubscriptionList,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::AzureSubscriptions { subscriptions },
        }
    }

    /// A device-wide Key Vault list. Not scoped to a run or session, so `session_id`/`run_id` are
    /// empty and `sequence` is `0`.
    pub fn key_vaults(
        id: impl Into<String>,
        created_at: impl Into<String>,
        vaults: KeyVaultList,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::KeyVaults { vaults },
        }
    }

    /// A device-wide vault-objects listing (one vault's secrets/keys/certificates). Not scoped to a
    /// run or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn vault_objects(
        id: impl Into<String>,
        created_at: impl Into<String>,
        objects: VaultObjects,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::VaultObjects { objects },
        }
    }

    /// A device-wide secret reveal (one secret's value). Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn secret_reveal(
        id: impl Into<String>,
        created_at: impl Into<String>,
        reveal: SecretReveal,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::SecretReveal { reveal },
        }
    }

    /// A device-wide Key Vault expiry scan. Not scoped to a run or session, so `session_id`/
    /// `run_id` are empty and `sequence` is `0`.
    pub fn key_vault_expiry(
        id: impl Into<String>,
        created_at: impl Into<String>,
        expiring: ExpiringObjects,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::KeyVaultExpiry { expiring },
        }
    }

    /// A device-wide Service Bus message peek. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_peek(
        id: impl Into<String>,
        created_at: impl Into<String>,
        peek: ServiceBusPeek,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusPeek { peek },
        }
    }

    /// A device-wide Service Bus dead-letter resubmit result. Not scoped to a run or session,
    /// so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_resubmit(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: ServiceBusResubmit,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusResubmit { result },
        }
    }

    /// A device-wide Service Bus purge result. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_purge(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: ServiceBusPurge,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusPurge { result },
        }
    }

    /// A device-wide Service Bus send result. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_send(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: ServiceBusSend,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusSend { result },
        }
    }

    /// A device-wide Service Bus receive result. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn service_bus_receive(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: ServiceBusReceive,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusReceive { result },
        }
    }

    /// A device-wide Service Bus entities listing (one connection's namespace).
    pub fn service_bus_entities(
        id: impl Into<String>,
        created_at: impl Into<String>,
        entities: ServiceBusEntities,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusEntities { entities },
        }
    }

    /// A device-wide Service Bus management result (create/delete/update of an entity).
    pub fn service_bus_manage(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: ServiceBusManage,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::ServiceBusManage { result },
        }
    }

    /// A device-wide Grafana summary. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn grafana_summary(
        id: impl Into<String>,
        created_at: impl Into<String>,
        summary: GrafanaSummary,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GrafanaSummary { summary },
        }
    }

    /// A device-wide Sentry summary. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn sentry_summary(
        id: impl Into<String>,
        created_at: impl Into<String>,
        summary: SentrySummary,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::SentrySummary { summary },
        }
    }

    /// A device-wide git-status event. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn git_status(
        id: impl Into<String>,
        created_at: impl Into<String>,
        status: GitStatus,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitStatus { status },
        }
    }

    /// A device-wide git-diff event. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    /// A device-wide multi-repo git overview (one status per discovered repo).
    pub fn git_overview(
        id: impl Into<String>,
        created_at: impl Into<String>,
        overview: GitOverview,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitOverview { overview },
        }
    }

    /// A device-wide git-branches event (local branches + the current one).
    pub fn git_branches(
        id: impl Into<String>,
        created_at: impl Into<String>,
        branches: GitBranches,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitBranches { branches },
        }
    }

    /// A device-wide git write-op result (feedback for stage/commit/push/pull/etc).
    pub fn git_op(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: GitOpResult,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitOp { result },
        }
    }

    /// A device-wide filesystem-change notification (host-pushed by the watcher).
    pub fn fs_changed(
        id: impl Into<String>,
        created_at: impl Into<String>,
        paths: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::FsChanged { paths },
        }
    }

    pub fn git_diff(id: impl Into<String>, created_at: impl Into<String>, diff: GitDiff) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitDiff { diff },
        }
    }

    /// A device-wide git file-versions event (a single file's `HEAD` + working-tree content
    /// for the side-by-side diff). Not scoped to a run or session, so `session_id`/`run_id`
    /// are empty and `sequence` is `0`.
    pub fn git_file_versions(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: GitFileVersions,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::GitFileVersions { result },
        }
    }

    /// A device-wide group-check result (one declared command run in a repo root). Not scoped
    /// to a run or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn check_result(
        id: impl Into<String>,
        created_at: impl Into<String>,
        result: CheckOutcome,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::CheckResult { result },
        }
    }

    /// A device-wide LSP message from a running language server. Host-synthesized, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn lsp_message(
        id: impl Into<String>,
        created_at: impl Into<String>,
        root: String,
        language_id: String,
        message: serde_json::Value,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::LspMessage {
                root,
                language_id,
                message,
            },
        }
    }

    /// A device-wide LSP lifecycle / capability status. Host-synthesized, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn lsp_status(
        id: impl Into<String>,
        created_at: impl Into<String>,
        status: LspStatus,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::LspStatus { status },
        }
    }

    /// A device-wide persisted-session-list event. Not scoped to a run or session, so
    /// `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn session_list(
        id: impl Into<String>,
        created_at: impl Into<String>,
        sessions: Vec<DispatchSession>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::SessionList { sessions },
        }
    }

    /// A device-wide persisted-session-detail event (runs + transcript of one session).
    /// Not scoped to a live run, so the envelope's `session_id`/`run_id` are empty.
    pub fn session_detail(
        id: impl Into<String>,
        created_at: impl Into<String>,
        session_id: String,
        runs: Vec<DispatchRun>,
        transcript: Vec<DispatchMessage>,
        usage: Option<UsageSummary>,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::SessionDetail {
                session_id,
                runs,
                transcript,
                usage,
            },
        }
    }

    /// A device-wide usage-probe result (one backend's plan meters). Host-only, like
    /// the other device-wide events: empty ids, `sequence = 0`.
    pub fn usage_probe(
        id: impl Into<String>,
        created_at: impl Into<String>,
        report: crate::usage_probe::UsageProbeReport,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::UsageProbe { report },
        }
    }

    /// A device-wide roadmap snapshot (parsed Architecture initiatives). Not scoped to a run
    /// or session, so `session_id`/`run_id` are empty and `sequence` is `0`.
    pub fn roadmap(
        id: impl Into<String>,
        created_at: impl Into<String>,
        roadmap: RoadmapSnapshot,
    ) -> Self {
        Self {
            id: id.into(),
            session_id: String::new(),
            run_id: String::new(),
            sequence: 0,
            created_at: created_at.into(),
            payload: BridgeEventPayload::Roadmap { roadmap },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeEventPayload {
    Message {
        message: DispatchMessage,
    },
    Control {
        event: DispatchControlEvent,
    },
    Usage {
        signal: UsageSignal,
    },
    PolicyHint {
        hint: PolicyHint,
    },
    Status {
        status: BridgeStatusEvent,
    },
    Artifact {
        artifact: DispatchArtifact,
    },
    Activity {
        activity: DispatchActivity,
    },
    UsageSummary {
        summary: UsageSummary,
    },
    CoachingHints {
        hints: Vec<PolicyHint>,
    },
    AgentCatalog {
        agents: Vec<AgentDefinition>,
    },
    BackendCatalog {
        backends: Vec<BackendCapability>,
    },
    DirListing {
        listing: DirListing,
    },
    FileContents {
        file: FileContents,
    },
    FileWritten {
        result: FileWriteResult,
    },
    SearchResults {
        results: SearchResults,
    },
    ContentSearchResults {
        results: ContentSearchResults,
    },
    WorkspaceFolders {
        folders: WorkspaceFolders,
    },
    AgentWritten {
        agent: AgentWriteOutcome,
    },
    JobSnapshot {
        snapshot: JobSnapshot,
    },
    EnvironmentInfo {
        environment: EnvironmentInfo,
    },
    NetworkInfo {
        network: NetworkInfo,
    },
    WorkSnapshot {
        snapshot: WorkSnapshot,
    },
    ServiceBusSnapshot {
        snapshot: ServiceBusSnapshot,
    },
    AzureSubscriptions {
        subscriptions: AzureSubscriptionList,
    },
    KeyVaults {
        vaults: KeyVaultList,
    },
    VaultObjects {
        objects: VaultObjects,
    },
    SecretReveal {
        reveal: SecretReveal,
    },
    KeyVaultExpiry {
        expiring: ExpiringObjects,
    },
    ServiceBusPeek {
        peek: ServiceBusPeek,
    },
    ServiceBusResubmit {
        result: ServiceBusResubmit,
    },
    ServiceBusPurge {
        result: ServiceBusPurge,
    },
    ServiceBusSend {
        result: ServiceBusSend,
    },
    ServiceBusReceive {
        result: ServiceBusReceive,
    },
    ServiceBusEntities {
        entities: ServiceBusEntities,
    },
    ServiceBusManage {
        result: ServiceBusManage,
    },
    GrafanaSummary {
        summary: GrafanaSummary,
    },
    SentrySummary {
        summary: SentrySummary,
    },
    GitStatus {
        status: GitStatus,
    },
    GitDiff {
        diff: GitDiff,
    },
    GitFileVersions {
        result: GitFileVersions,
    },
    GitOverview {
        overview: GitOverview,
    },
    GitBranches {
        branches: GitBranches,
    },
    GitOp {
        result: GitOpResult,
    },
    FsChanged {
        paths: Vec<String>,
    },
    SessionList {
        sessions: Vec<DispatchSession>,
    },
    SessionDetail {
        session_id: String,
        runs: Vec<DispatchRun>,
        transcript: Vec<DispatchMessage>,
        /// The session's usage rolled up per (backend, fidelity) — the per-thread
        /// cost view. Absent when the session recorded no usage signals (additive).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<UsageSummary>,
    },
    /// The result of one backend's plan-usage probe (host-synthesized, device-wide).
    UsageProbe {
        report: crate::usage_probe::UsageProbeReport,
    },
    Roadmap {
        roadmap: RoadmapSnapshot,
    },
    CheckResult {
        result: CheckOutcome,
    },
    /// One LSP JSON-RPC message from a running language server (a response, or a server
    /// notification such as `textDocument/publishDiagnostics`). Host-synthesized and
    /// device-wide (empty session/run ids, `sequence = 0`); the cockpit routes it to the
    /// matching (`language_id`, `root`) client. Rejected from backend streams by the stream
    /// validator, like every host-synthesized channel.
    LspMessage {
        root: String,
        #[serde(rename = "languageId")]
        language_id: String,
        message: serde_json::Value,
    },
    /// A language-server lifecycle / capability signal (running / installed / exited) — the
    /// honest degradation flag (ADR-0090 D4). Host-synthesized, device-wide.
    LspStatus {
        status: LspStatus,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusEvent {
    pub state: DispatchRunState,
    pub backend: AgentBackend,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::AgentBackend;
    use crate::artifact::ArtifactKind;
    use crate::session::{
        DispatchControlEventKind, DispatchMessageRole, DispatchSession, PolicyHintSeverity,
        UsageConfidence, UsageFidelity,
    };
    use serde_json::json;

    #[test]
    fn serializes_versioned_server_event_frame() {
        let event = BridgeEvent::status(
            "event-1",
            "session-1",
            "run-1",
            1,
            "2026-06-07T12:00:00Z",
            BridgeStatusEvent {
                state: DispatchRunState::Running,
                backend: AgentBackend::ClaudeLocal,
                repo_hint: Some("HoneyDrunk.HoneyHub".to_string()),
                link: None,
            },
        );
        let frame = WireFrame::server_event("frame-1", event, "2026-06-07T12:00:00Z");

        assert_eq!(
            serde_json::to_value(frame).expect("frame serializes"),
            json!({
                "protocol": "honeyhub.bridge.v1",
                "frameId": "frame-1",
                "kind": "server_event",
                "createdAt": "2026-06-07T12:00:00Z",
                "event": {
                    "id": "event-1",
                    "sessionId": "session-1",
                    "runId": "run-1",
                    "sequence": 1,
                    "createdAt": "2026-06-07T12:00:00Z",
                    "payload": {
                        "kind": "status",
                        "status": {
                            "state": "running",
                            "backend": "claude.local",
                            "repoHint": "HoneyDrunk.HoneyHub"
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn serializes_artifact_server_event_frame() {
        let event = BridgeEvent::artifact(
            "event-2",
            "session-1",
            "run-1",
            2,
            "2026-06-07T12:00:00Z",
            DispatchArtifact {
                id: "artifact-1".to_string(),
                session_id: "session-1".to_string(),
                run_id: "run-1".to_string(),
                kind: ArtifactKind::PullRequest,
                label: "Open PR".to_string(),
                href: Some("https://example.test/pr/1".to_string()),
                repo_relative_path: None,
                created_at: "2026-06-07T12:00:00Z".to_string(),
            },
        );
        let frame = WireFrame::server_event("frame-2", event, "2026-06-07T12:00:00Z");

        assert_eq!(
            serde_json::to_value(frame).expect("frame serializes"),
            json!({
                "protocol": "honeyhub.bridge.v1",
                "frameId": "frame-2",
                "kind": "server_event",
                "createdAt": "2026-06-07T12:00:00Z",
                "event": {
                    "id": "event-2",
                    "sessionId": "session-1",
                    "runId": "run-1",
                    "sequence": 2,
                    "createdAt": "2026-06-07T12:00:00Z",
                    "payload": {
                        "kind": "artifact",
                        "artifact": {
                            "id": "artifact-1",
                            "sessionId": "session-1",
                            "runId": "run-1",
                            "kind": "pull_request",
                            "label": "Open PR",
                            "href": "https://example.test/pr/1",
                            "createdAt": "2026-06-07T12:00:00Z"
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn serializes_client_command_fields_as_camel_case() {
        let command = ClientCommand::Resume {
            session_id_or_transcript: "session-1".to_string(),
        };

        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({
                "kind": "resume",
                "sessionIdOrTranscript": "session-1"
            })
        );
    }

    #[test]
    fn serializes_write_file_command_and_file_written_event() {
        // The command tag is snake_case and its fields camelCase.
        let command = ClientCommand::WriteFile {
            path: "C:/work/a.txt".to_string(),
            content: "hello".to_string(),
        };
        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({
                "kind": "write_file",
                "path": "C:/work/a.txt",
                "content": "hello"
            })
        );

        // The event payload tag is snake_case and the result's fields camelCase; the
        // optional `message` is omitted when absent.
        let event = BridgeEvent::file_written(
            "e",
            "2026-07-04T00:00:00Z",
            FileWriteResult {
                path: "C:/work/a.txt".to_string(),
                ok: true,
                message: None,
            },
        );
        let value = serde_json::to_value(&event).expect("event serializes");
        assert_eq!(value["payload"]["kind"], json!("file_written"));
        assert_eq!(value["payload"]["result"]["path"], json!("C:/work/a.txt"));
        assert_eq!(value["payload"]["result"]["ok"], json!(true));
        assert!(value["payload"]["result"].get("message").is_none());

        // And it round-trips back to the same variant.
        let decoded: BridgeEvent = serde_json::from_value(value).expect("event deserializes");
        assert!(matches!(
            decoded.payload,
            BridgeEventPayload::FileWritten { .. }
        ));
    }

    #[test]
    fn serializes_search_content_command_and_event() {
        use crate::contentsearch::{ContentMatch, ContentSearchEngine, ContentSearchResults};

        // The command tag is snake_case and its flag fields camelCase.
        let command = ClientCommand::SearchContent {
            root: "C:/repo".to_string(),
            query: "needle".to_string(),
            case_sensitive: true,
            whole_word: false,
            is_regex: false,
        };
        assert_eq!(
            serde_json::to_value(&command).expect("command serializes"),
            json!({
                "kind": "search_content",
                "root": "C:/repo",
                "query": "needle",
                "caseSensitive": true,
                "wholeWord": false,
                "isRegex": false
            })
        );
        // A stale client that omits the flag fields still parses (they default to false).
        let lean: ClientCommand = serde_json::from_value(json!({
            "kind": "search_content",
            "root": "C:/repo",
            "query": "needle"
        }))
        .expect("lean command deserializes");
        assert!(matches!(
            lean,
            ClientCommand::SearchContent {
                case_sensitive: false,
                whole_word: false,
                is_regex: false,
                ..
            }
        ));

        // The event payload tag is snake_case; the results' fields camelCase and the optional
        // `column` is omitted when absent.
        let event = BridgeEvent::content_search_results(
            "e",
            "2026-07-05T00:00:00Z",
            ContentSearchResults {
                root: "C:/repo".to_string(),
                query: "needle".to_string(),
                case_sensitive: true,
                whole_word: false,
                is_regex: false,
                matches: vec![ContentMatch {
                    path: "C:/repo/a.rs".to_string(),
                    line: 12,
                    column: Some(5),
                    line_text: "    let needle = 1;".to_string(),
                }],
                file_count: 1,
                truncated: false,
                engine: ContentSearchEngine::Ripgrep,
            },
        );
        let value = serde_json::to_value(&event).expect("event serializes");
        assert_eq!(value["payload"]["kind"], json!("content_search_results"));
        assert_eq!(value["payload"]["results"]["fileCount"], json!(1));
        assert_eq!(value["payload"]["results"]["engine"], json!("ripgrep"));
        assert_eq!(value["payload"]["results"]["matches"][0]["line"], json!(12));
        assert_eq!(
            value["payload"]["results"]["matches"][0]["lineText"],
            json!("    let needle = 1;")
        );
        assert_eq!(
            value["payload"]["results"]["matches"][0]["column"],
            json!(5)
        );

        // And it round-trips back to the same variant.
        let decoded: BridgeEvent = serde_json::from_value(value).expect("event deserializes");
        assert!(matches!(
            decoded.payload,
            BridgeEventPayload::ContentSearchResults { .. }
        ));
    }

    #[test]
    fn serializes_git_file_versions_command_and_event() {
        // The command tag is snake_case and its fields camelCase.
        let command = ClientCommand::GitFileVersions {
            root: "C:/repo".to_string(),
            path: "src/app.tsx".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&command).expect("command serializes"),
            json!({
                "kind": "git_file_versions",
                "root": "C:/repo",
                "path": "src/app.tsx"
            })
        );
        // And the command round-trips back to the same variant.
        let decoded: ClientCommand =
            serde_json::from_value(serde_json::to_value(&command).unwrap())
                .expect("command deserializes");
        assert!(matches!(decoded, ClientCommand::GitFileVersions { .. }));

        // The event payload tag is snake_case and the result's fields camelCase.
        let event = BridgeEvent::git_file_versions(
            "e",
            "2026-07-05T00:00:00Z",
            GitFileVersions {
                root: "C:/repo".to_string(),
                path: "src/app.tsx".to_string(),
                original: "old".to_string(),
                modified: "new".to_string(),
                existed_in_head: true,
                existed_in_work: true,
            },
        );
        let value = serde_json::to_value(&event).expect("event serializes");
        assert_eq!(value["payload"]["kind"], json!("git_file_versions"));
        assert_eq!(value["payload"]["result"]["path"], json!("src/app.tsx"));
        assert_eq!(value["payload"]["result"]["original"], json!("old"));
        assert_eq!(value["payload"]["result"]["modified"], json!("new"));
        assert_eq!(value["payload"]["result"]["existedInHead"], json!(true));
        assert_eq!(value["payload"]["result"]["existedInWork"], json!(true));

        // And it round-trips back to the same variant.
        let decoded: BridgeEvent = serde_json::from_value(value).expect("event deserializes");
        assert!(matches!(
            decoded.payload,
            BridgeEventPayload::GitFileVersions { .. }
        ));
    }

    #[test]
    fn serializes_usage_summary_query_as_fieldless_tagged_command() {
        // The query carries no payload; it must serialize as just the tag so the
        // client can send a bare `{"kind":"usage_summary"}` (snake_case, per the
        // enum's `rename_all`).
        let command = ClientCommand::UsageSummary;
        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({ "kind": "usage_summary" })
        );
    }

    #[test]
    fn serializes_coaching_hints_query_as_fieldless_tagged_command() {
        let command = ClientCommand::CoachingHints;
        assert_eq!(
            serde_json::to_value(command).expect("command serializes"),
            json!({ "kind": "coaching_hints" })
        );
    }

    #[test]
    fn serializes_discover_agents_command_with_optional_root() {
        assert_eq!(
            serde_json::to_value(ClientCommand::DiscoverAgents {
                workspace_root: None
            })
            .expect("serializes"),
            json!({ "kind": "discover_agents" })
        );
        assert_eq!(
            serde_json::to_value(ClientCommand::DiscoverAgents {
                workspace_root: Some("C:/work".to_string())
            })
            .expect("serializes"),
            json!({ "kind": "discover_agents", "workspaceRoot": "C:/work" })
        );
    }

    #[test]
    fn parses_run_check_and_tolerates_the_legacy_command_field() {
        let current: ClientCommand = serde_json::from_value(
            json!({ "kind": "run_check", "root": "C:/work", "check": "npm-test" }),
        )
        .expect("current shape parses");
        assert_eq!(
            current,
            ClientCommand::RunCheck {
                root: "C:/work".to_string(),
                check: "npm-test".to_string(),
            }
        );
        // A stale pre-rename client sends `command`; the alias maps it onto `check`
        // so the request degrades into an id-allowlist denial, not a bad frame.
        let legacy: ClientCommand = serde_json::from_value(
            json!({ "kind": "run_check", "root": "C:/work", "command": "npm test" }),
        )
        .expect("legacy shape parses");
        assert_eq!(
            legacy,
            ClientCommand::RunCheck {
                root: "C:/work".to_string(),
                check: "npm test".to_string(),
            }
        );
    }

    #[test]
    fn lsp_commands_and_events_use_camel_case_and_carry_opaque_payloads() {
        // The command fields camelCase on the wire (`languageId`) and the message is carried
        // verbatim as an opaque JSON value.
        let send = ClientCommand::LspSend {
            root: "C:/work".to_string(),
            language_id: "typescript".to_string(),
            message: json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
        };
        let encoded = serde_json::to_value(&send).expect("encode lsp_send");
        assert_eq!(encoded["kind"], json!("lsp_send"));
        assert_eq!(encoded["languageId"], json!("typescript"));
        assert_eq!(encoded["message"]["method"], json!("initialize"));
        let decoded: ClientCommand = serde_json::from_value(encoded).expect("decode lsp_send");
        assert_eq!(decoded, send);

        // The message event mirrors the same camelCase key and opaque payload.
        let event = BridgeEvent::lsp_message(
            "e1",
            "2026-06-07T12:00:00Z",
            "C:/work".to_string(),
            "rust".to_string(),
            json!({ "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics" }),
        );
        let encoded = serde_json::to_value(&event.payload).expect("encode lsp_message");
        assert_eq!(encoded["kind"], json!("lsp_message"));
        assert_eq!(encoded["languageId"], json!("rust"));
        assert_eq!(
            encoded["message"]["method"],
            json!("textDocument/publishDiagnostics")
        );

        // The status event carries the honest degradation flags.
        let status = BridgeEvent::lsp_status(
            "e2",
            "2026-06-07T12:00:00Z",
            crate::lsp::LspStatus {
                root: "C:/work".to_string(),
                language_id: "python".to_string(),
                server_id: String::new(),
                installed: false,
                running: false,
                reason: "no language server is allowlisted for this language".to_string(),
            },
        );
        let encoded = serde_json::to_value(&status.payload).expect("encode lsp_status");
        assert_eq!(encoded["kind"], json!("lsp_status"));
        assert_eq!(encoded["status"]["languageId"], json!("python"));
        assert_eq!(encoded["status"]["installed"], json!(false));
    }

    #[test]
    fn round_trips_wire_frames_and_payload_variants() {
        let created_at = "2026-06-07T12:00:00Z";
        let message = DispatchMessage {
            id: "message-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            role: DispatchMessageRole::Agent,
            body: "hello, \"HoneyHub\"".to_string(),
            created_at: created_at.to_string(),
            is_partial: Some(false),
        };
        let control = DispatchControlEvent {
            id: "control-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            kind: DispatchControlEventKind::Reply,
            created_at: created_at.to_string(),
            summary: "reply accepted".to_string(),
        };
        let usage = UsageSignal {
            id: "usage-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity: UsageFidelity::Estimated,
            model_label: Some("claude".to_string()),
            input_tokens: Some(0),
            output_tokens: Some(0),
            total_tokens: Some(0),
            total_usd: None,
            premium_requests: None,
            duration_ms: Some(0),
            confidence: Some(UsageConfidence::Low),
            recorded_at: created_at.to_string(),
        };
        let hint = PolicyHint {
            id: "hint-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            code: "empty-field".to_string(),
            severity: PolicyHintSeverity::Info,
            message: "".to_string(),
            created_at: created_at.to_string(),
        };
        let frames = vec![
            WireFrame::client_command(
                "frame-start",
                ClientCommand::Start {
                    request: Box::new(StartRunRequest {
                        session: DispatchSession {
                            pinned: false,
                            id: "session-1".to_string(),
                            backend: AgentBackend::ClaudeLocal,
                            title: "Bridge".to_string(),
                            workspace_root: "C:/work/honeyhub".to_string(),
                            created_at: created_at.to_string(),
                            updated_at: created_at.to_string(),
                            current_run_id: None,
                        },
                        workspace_root: "C:/work/honeyhub".to_string(),
                        task: "run with emoji-safe text: <>&".to_string(),
                        model: None,
                        agent: None,
                        effort: None,
                        requested_run_id: Some("run-1".to_string()),
                        follow_up_to_run_id: None,
                        transcript: Vec::new(),
                        launch_command: None,
                        attachments: Vec::new(),
                        parent_run_id: None,
                        parent_session_id: None,
                    }),
                },
                created_at,
            ),
            WireFrame::server_event(
                "frame-message",
                BridgeEvent::message(
                    "event-message",
                    "session-1",
                    "run-1",
                    1,
                    created_at,
                    message,
                ),
                created_at,
            ),
            WireFrame::server_event(
                "frame-control",
                BridgeEvent::control(
                    "event-control",
                    "session-1",
                    "run-1",
                    2,
                    created_at,
                    control,
                ),
                created_at,
            ),
            WireFrame::server_event(
                "frame-usage",
                BridgeEvent::usage("event-usage", "session-1", "run-1", 3, created_at, usage),
                created_at,
            ),
            WireFrame::server_event(
                "frame-hint",
                BridgeEvent::policy_hint("event-hint", "session-1", "run-1", 4, created_at, hint),
                created_at,
            ),
            WireFrame::server_event(
                "frame-artifact",
                BridgeEvent::artifact(
                    "event-artifact",
                    "session-1",
                    "run-1",
                    5,
                    created_at,
                    DispatchArtifact {
                        id: "artifact-1".to_string(),
                        session_id: "session-1".to_string(),
                        run_id: "run-1".to_string(),
                        kind: ArtifactKind::Branch,
                        label: "feature/x".to_string(),
                        href: None,
                        repo_relative_path: Some("crates/bridge".to_string()),
                        created_at: created_at.to_string(),
                    },
                ),
                created_at,
            ),
            WireFrame::client_command(
                "frame-reply",
                ClientCommand::Reply {
                    run_id: "run-1".to_string(),
                    text: "special chars: \n\t\"".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-stop",
                ClientCommand::Stop {
                    run_id: "run-1".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-resume",
                ClientCommand::Resume {
                    session_id_or_transcript: "session-1".to_string(),
                },
                created_at,
            ),
            WireFrame::client_command(
                "frame-reconnect",
                ClientCommand::Reconnect {
                    request: ReconnectRequest {
                        session_id: "session-1".to_string(),
                        run_id: Some("run-1".to_string()),
                        last_event_id: Some("event-4".to_string()),
                    },
                },
                created_at,
            ),
            WireFrame::client_command("frame-usage-query", ClientCommand::UsageSummary, created_at),
            WireFrame::server_event(
                "frame-usage-summary",
                BridgeEvent::usage_summary(
                    "event-usage-summary",
                    created_at,
                    crate::session::UsageSummary::from_signals(
                        &[UsageSignal {
                            id: "u1".to_string(),
                            session_id: "session-1".to_string(),
                            run_id: "run-1".to_string(),
                            backend: AgentBackend::ClaudeLocal,
                            fidelity: UsageFidelity::Exact,
                            model_label: None,
                            input_tokens: Some(10),
                            output_tokens: Some(5),
                            total_tokens: Some(15),
                            total_usd: Some(0.01),
                            premium_requests: None,
                            duration_ms: Some(100),
                            confidence: None,
                            recorded_at: created_at.to_string(),
                        }],
                        1,
                    ),
                ),
                created_at,
            ),
            WireFrame::client_command(
                "frame-coaching-query",
                ClientCommand::CoachingHints,
                created_at,
            ),
            WireFrame::server_event(
                "frame-coaching-hints",
                BridgeEvent::coaching_hints(
                    "event-coaching-hints",
                    created_at,
                    vec![PolicyHint {
                        id: "coach:session-1:stale_session".to_string(),
                        session_id: "session-1".to_string(),
                        run_id: Some("run-1".to_string()),
                        code: "stale_session".to_string(),
                        severity: PolicyHintSeverity::Warning,
                        message: "This session is large.".to_string(),
                        created_at: created_at.to_string(),
                    }],
                ),
                created_at,
            ),
            WireFrame::client_command(
                "frame-discover-agents",
                ClientCommand::DiscoverAgents {
                    workspace_root: Some("C:/work".to_string()),
                },
                created_at,
            ),
            WireFrame::server_event(
                "frame-agent-catalog",
                BridgeEvent::agent_catalog(
                    "event-agent-catalog",
                    created_at,
                    vec![crate::agents::AgentDefinition {
                        id: "a1b2c3d4e5f6a7b8".to_string(),
                        name: "Reviewer".to_string(),
                        backends: vec![crate::agents::AgentBackendBinding {
                            backend: AgentBackend::ClaudeLocal,
                            description: "Reviews diffs".to_string(),
                            model: Some("claude-opus".to_string()),
                            source_path: ".claude/agents/reviewer.md".to_string(),
                            scope: crate::agents::AgentScope::Project,
                            workspace_label: "work".to_string(),
                        }],
                    }],
                ),
                created_at,
            ),
            WireFrame::ack("frame-ack", "frame-reply", created_at),
            WireFrame::error(
                "frame-error",
                BridgeError::new("bad_request", "invalid frame"),
                created_at,
            ),
        ];

        for frame in frames {
            let value = serde_json::to_value(&frame).expect("frame serializes");
            let round_trip: WireFrame = serde_json::from_value(value).expect("frame deserializes");
            assert_eq!(round_trip, frame);
        }
    }

    /// Exercise every `BridgeEvent::*` associated constructor so the unit-test pass counts
    /// each one as covered (they are otherwise only hit by an integration test). Each
    /// constructor is called with a freshly-built payload, then we assert the event
    /// serializes to a non-empty string and carries the expected `BridgeEventPayload`
    /// variant — which also drives the payload serialization paths.
    #[test]
    fn every_bridge_event_constructor_builds_and_serializes() {
        let at = "2026-06-15T00:00:00Z";

        // Helper: build a payload value from camelCase JSON (matches the crate's serde).
        macro_rules! from_json {
            ($ty:ty, $value:tt) => {{
                let value = json!($value);
                serde_json::from_value::<$ty>(value).expect("payload deserializes")
            }};
        }

        // Helper: assert the event serializes to a non-empty string and matches a variant.
        macro_rules! check {
            ($event:expr, $pat:pat) => {{
                let event = $event;
                let text = serde_json::to_string(&event).expect("event serializes");
                assert!(!text.is_empty(), "serialized event must be non-empty");
                assert!(
                    matches!(event.payload, $pat),
                    "payload variant mismatch for {}",
                    stringify!($pat)
                );
            }};
        }

        // --- run-scoped constructors (id, session, run, sequence, created_at, payload) ---
        check!(
            BridgeEvent::status(
                "e",
                "s",
                "r",
                1,
                at,
                BridgeStatusEvent {
                    state: DispatchRunState::Running,
                    backend: AgentBackend::ClaudeLocal,
                    repo_hint: None,
                    link: None,
                },
            ),
            BridgeEventPayload::Status { .. }
        );
        check!(
            BridgeEvent::message(
                "e",
                "s",
                "r",
                2,
                at,
                from_json!(DispatchMessage, {
                    "id": "m1",
                    "sessionId": "s",
                    "runId": "r",
                    "role": "agent",
                    "body": "hello",
                    "createdAt": at
                }),
            ),
            BridgeEventPayload::Message { .. }
        );
        check!(
            BridgeEvent::control(
                "e",
                "s",
                "r",
                3,
                at,
                from_json!(DispatchControlEvent, {
                    "id": "c1",
                    "sessionId": "s",
                    "runId": "r",
                    "kind": "reply",
                    "createdAt": at,
                    "summary": "ok"
                }),
            ),
            BridgeEventPayload::Control { .. }
        );
        check!(
            BridgeEvent::usage(
                "e",
                "s",
                "r",
                4,
                at,
                from_json!(UsageSignal, {
                    "id": "u1",
                    "sessionId": "s",
                    "runId": "r",
                    "backend": "claude.local",
                    "fidelity": "exact",
                    "recordedAt": at
                }),
            ),
            BridgeEventPayload::Usage { .. }
        );
        let policy_hint = from_json!(PolicyHint, {
            "id": "h1",
            "sessionId": "s",
            "code": "local_only",
            "severity": "info",
            "message": "stay local",
            "createdAt": at
        });
        check!(
            BridgeEvent::policy_hint("e", "s", "r", 5, at, policy_hint.clone()),
            BridgeEventPayload::PolicyHint { .. }
        );
        check!(
            BridgeEvent::artifact(
                "e",
                "s",
                "r",
                6,
                at,
                from_json!(DispatchArtifact, {
                    "id": "a1",
                    "sessionId": "s",
                    "runId": "r",
                    "kind": "branch",
                    "label": "feature/x",
                    "createdAt": at
                }),
            ),
            BridgeEventPayload::Artifact { .. }
        );
        check!(
            BridgeEvent::activity(
                "e",
                "s",
                "r",
                7,
                at,
                from_json!(DispatchActivity, {
                    "id": "act1",
                    "sessionId": "s",
                    "runId": "r",
                    "kind": "read",
                    "label": "Read",
                    "createdAt": at
                }),
            ),
            BridgeEventPayload::Activity { .. }
        );

        // --- device-wide constructors (id, created_at, payload) ---
        check!(
            BridgeEvent::usage_summary(
                "e",
                at,
                from_json!(UsageSummary, {
                    "sessionCount": 0,
                    "totalTurns": 0,
                    "rollups": [],
                    "totalPremiumRequests": 0
                }),
            ),
            BridgeEventPayload::UsageSummary { .. }
        );
        check!(
            BridgeEvent::coaching_hints("e", at, vec![policy_hint.clone()]),
            BridgeEventPayload::CoachingHints { .. }
        );
        check!(
            BridgeEvent::agent_catalog(
                "e",
                at,
                vec![from_json!(AgentDefinition, {
                    "id": "abc123",
                    "name": "Reviewer",
                    "backends": [{
                        "backend": "claude.local",
                        "description": "Reviews diffs",
                        "model": "opus",
                        "sourcePath": ".claude/agents/reviewer.md",
                        "scope": "project",
                        "workspaceLabel": "work"
                    }]
                })],
            ),
            BridgeEventPayload::AgentCatalog { .. }
        );
        check!(
            BridgeEvent::backend_catalog(
                "e",
                at,
                vec![from_json!(BackendCapability, {
                    "backend": "claude.local",
                    "program": "claude",
                    "available": true,
                    "capabilities": {
                        "streaming_output": true,
                        "interactive_reply": true,
                        "resume_session": true,
                        "stop_signal": true,
                        "structured_events": true,
                        "usage_exact": true,
                        "usage_derived": false,
                        "usage_estimated": false
                    },
                    "models": [{ "id": "opus", "label": "Opus" }],
                    "modelSource": "cli_alias"
                })],
            ),
            BridgeEventPayload::BackendCatalog { .. }
        );
        check!(
            BridgeEvent::dir_listing(
                "e",
                at,
                from_json!(DirListing, {
                    "path": "C:/work",
                    "entries": [{ "name": "src", "kind": "dir" }],
                    "truncated": false
                }),
            ),
            BridgeEventPayload::DirListing { .. }
        );
        check!(
            BridgeEvent::file_contents(
                "e",
                at,
                from_json!(FileContents, {
                    "path": "C:/work/a.txt",
                    "content": "hi",
                    "truncated": false,
                    "byteSize": 2
                }),
            ),
            BridgeEventPayload::FileContents { .. }
        );
        check!(
            BridgeEvent::file_written(
                "e",
                at,
                from_json!(FileWriteResult, {
                    "path": "C:/work/a.txt",
                    "ok": true
                }),
            ),
            BridgeEventPayload::FileWritten { .. }
        );
        check!(
            BridgeEvent::search_results(
                "e",
                at,
                from_json!(SearchResults, {
                    "root": "C:/work",
                    "query": "main",
                    "hits": [{ "path": "C:/work/main.rs", "name": "main.rs" }],
                    "truncated": false
                }),
            ),
            BridgeEventPayload::SearchResults { .. }
        );
        check!(
            BridgeEvent::workspace_folders(
                "e",
                at,
                from_json!(WorkspaceFolders, {
                    "workspaceFile": "C:/work/x.code-workspace",
                    "folders": ["C:/work/a", "C:/work/b"]
                }),
            ),
            BridgeEventPayload::WorkspaceFolders { .. }
        );
        check!(
            BridgeEvent::agent_written(
                "e",
                at,
                from_json!(AgentWriteOutcome, {
                    "name": "reviewer",
                    "sourcePath": ".claude/agents/reviewer.md",
                    "scope": "project"
                }),
            ),
            BridgeEventPayload::AgentWritten { .. }
        );
        check!(
            BridgeEvent::job_snapshot(
                "e",
                at,
                from_json!(JobSnapshot, {
                    "known": [],
                    "scheduled": [],
                    "processes": [],
                    "truncated": false
                }),
            ),
            BridgeEventPayload::JobSnapshot { .. }
        );
        check!(
            BridgeEvent::environment_info(
                "e",
                at,
                from_json!(EnvironmentInfo, {
                    "backends": [{
                        "backend": "claude.local",
                        "program": "claude",
                        "available": true,
                        "version": "1.2.3"
                    }]
                }),
            ),
            BridgeEventPayload::EnvironmentInfo { .. }
        );
        check!(
            BridgeEvent::network_info(
                "e",
                at,
                from_json!(NetworkInfo, {
                    "addresses": [{ "ip": "100.64.0.1", "kind": "tailnet" }]
                }),
            ),
            BridgeEventPayload::NetworkInfo { .. }
        );
        check!(
            BridgeEvent::work_snapshot(
                "e",
                at,
                from_json!(WorkSnapshot, {
                    "sources": [{
                        "source": "github",
                        "available": true,
                        "items": []
                    }]
                }),
            ),
            BridgeEventPayload::WorkSnapshot { .. }
        );
        check!(
            BridgeEvent::service_bus_snapshot(
                "e",
                at,
                from_json!(ServiceBusSnapshot, {
                    "available": true,
                    "namespaces": []
                }),
            ),
            BridgeEventPayload::ServiceBusSnapshot { .. }
        );
        check!(
            BridgeEvent::azure_subscriptions(
                "e",
                at,
                from_json!(AzureSubscriptionList, {
                    "available": true,
                    "subscriptions": []
                }),
            ),
            BridgeEventPayload::AzureSubscriptions { .. }
        );
        check!(
            BridgeEvent::key_vaults(
                "e",
                at,
                from_json!(KeyVaultList, {
                    "available": true,
                    "vaults": []
                }),
            ),
            BridgeEventPayload::KeyVaults { .. }
        );
        check!(
            BridgeEvent::vault_objects(
                "e",
                at,
                from_json!(VaultObjects, {
                    "available": true,
                    "vault": "kv",
                    "subscriptionId": "sub",
                    "objects": []
                }),
            ),
            BridgeEventPayload::VaultObjects { .. }
        );
        check!(
            BridgeEvent::secret_reveal(
                "e",
                at,
                from_json!(SecretReveal, {
                    "ok": true,
                    "vault": "kv",
                    "subscriptionId": "sub",
                    "name": "db-password",
                    "value": "s3cr3t"
                }),
            ),
            BridgeEventPayload::SecretReveal { .. }
        );
        check!(
            BridgeEvent::key_vault_expiry(
                "e",
                at,
                from_json!(ExpiringObjects, {
                    "available": true,
                    "objects": []
                }),
            ),
            BridgeEventPayload::KeyVaultExpiry { .. }
        );
        check!(
            BridgeEvent::service_bus_peek(
                "e",
                at,
                from_json!(ServiceBusPeek, {
                    "available": true,
                    "namespace": "ns.servicebus.windows.net",
                    "entity": "orders",
                    "deadLetter": false,
                    "messages": []
                }),
            ),
            BridgeEventPayload::ServiceBusPeek { .. }
        );
        check!(
            BridgeEvent::service_bus_resubmit(
                "e",
                at,
                from_json!(ServiceBusResubmit, {
                    "ok": true,
                    "moved": 2,
                    "namespace": "ns.servicebus.windows.net",
                    "entity": "orders"
                }),
            ),
            BridgeEventPayload::ServiceBusResubmit { .. }
        );
        check!(
            BridgeEvent::service_bus_purge(
                "e",
                at,
                from_json!(ServiceBusPurge, {
                    "ok": true,
                    "purged": 5,
                    "namespace": "ns.servicebus.windows.net",
                    "entity": "orders",
                    "deadLetter": true
                }),
            ),
            BridgeEventPayload::ServiceBusPurge { .. }
        );
        check!(
            BridgeEvent::service_bus_send(
                "e",
                at,
                from_json!(ServiceBusSend, {
                    "ok": true,
                    "namespace": "ns.servicebus.windows.net",
                    "entity": "orders"
                }),
            ),
            BridgeEventPayload::ServiceBusSend { .. }
        );
        check!(
            BridgeEvent::service_bus_receive(
                "e",
                at,
                from_json!(ServiceBusReceive, {
                    "ok": true,
                    "empty": true,
                    "namespace": "ns.servicebus.windows.net",
                    "entity": "orders",
                    "deadLetter": false
                }),
            ),
            BridgeEventPayload::ServiceBusReceive { .. }
        );
        check!(
            BridgeEvent::service_bus_entities(
                "e",
                at,
                from_json!(ServiceBusEntities, {
                    "available": true,
                    "namespace": "ns.servicebus.windows.net",
                    "queues": [],
                    "topics": []
                }),
            ),
            BridgeEventPayload::ServiceBusEntities { .. }
        );
        check!(
            BridgeEvent::service_bus_manage(
                "e",
                at,
                from_json!(ServiceBusManage, {
                    "ok": true,
                    "namespace": "ns.servicebus.windows.net",
                    "op": "create",
                    "kind": "queue",
                    "entity": "orders"
                }),
            ),
            BridgeEventPayload::ServiceBusManage { .. }
        );
        check!(
            BridgeEvent::grafana_summary(
                "e",
                at,
                from_json!(GrafanaSummary, {
                    "available": true,
                    "baseUrl": "https://grafana.example.com",
                    "version": "10.4.2",
                    "dashboards": []
                }),
            ),
            BridgeEventPayload::GrafanaSummary { .. }
        );
        check!(
            BridgeEvent::sentry_summary(
                "e",
                at,
                from_json!(SentrySummary, {
                    "available": true,
                    "issues": []
                }),
            ),
            BridgeEventPayload::SentrySummary { .. }
        );
        check!(
            BridgeEvent::git_status(
                "e",
                at,
                from_json!(GitStatus, {
                    "root": "C:/work",
                    "branch": "main",
                    "ahead": 0,
                    "behind": 0,
                    "files": [],
                    "clean": true
                }),
            ),
            BridgeEventPayload::GitStatus { .. }
        );
        check!(
            BridgeEvent::git_diff(
                "e",
                at,
                from_json!(GitDiff, {
                    "root": "C:/work",
                    "patch": "diff --git a/x b/x",
                    "truncated": false
                }),
            ),
            BridgeEventPayload::GitDiff { .. }
        );
        check!(
            BridgeEvent::git_overview(
                "e",
                at,
                from_json!(GitOverview, {
                    "root": "C:/work",
                    "repos": []
                }),
            ),
            BridgeEventPayload::GitOverview { .. }
        );
        check!(
            BridgeEvent::git_branches(
                "e",
                at,
                from_json!(GitBranches, {
                    "root": "C:/work",
                    "current": "main",
                    "branches": ["main", "dev"]
                }),
            ),
            BridgeEventPayload::GitBranches { .. }
        );
        check!(
            BridgeEvent::git_op(
                "e",
                at,
                from_json!(GitOpResult, {
                    "root": "C:/work",
                    "op": "commit",
                    "ok": true,
                    "message": "1 file changed"
                }),
            ),
            BridgeEventPayload::GitOp { .. }
        );
        check!(
            BridgeEvent::fs_changed("e", at, vec!["C:/work/src/a.rs".to_string()]),
            BridgeEventPayload::FsChanged { .. }
        );
        check!(
            BridgeEvent::session_list(
                "e",
                at,
                vec![from_json!(DispatchSession, {
                    "id": "s1",
                    "backend": "claude.local",
                    "title": "Bridge",
                    "workspaceRoot": "C:/work",
                    "createdAt": at,
                    "updatedAt": at
                })],
            ),
            BridgeEventPayload::SessionList { .. }
        );
        check!(
            BridgeEvent::session_detail(
                "e",
                at,
                "s1".to_string(),
                vec![from_json!(DispatchRun, {
                    "id": "r1",
                    "sessionId": "s1",
                    "state": "completed",
                    "task": "build"
                })],
                vec![from_json!(DispatchMessage, {
                    "id": "m1",
                    "sessionId": "s1",
                    "runId": "r1",
                    "role": "agent",
                    "body": "done",
                    "createdAt": at
                })],
                Some(crate::session::UsageSummary::from_signals(&[], 1)),
            ),
            BridgeEventPayload::SessionDetail { .. }
        );
        check!(
            BridgeEvent::usage_probe(
                "e",
                at,
                crate::usage_probe::UsageProbeReport {
                    backend: crate::adapter::AgentBackend::ClaudeLocal,
                    ok: true,
                    windows: vec![crate::usage_probe::UsageWindow {
                        line: "Current session 5% used".to_string(),
                        used_percent: Some(5.0),
                    }],
                    raw: "raw".to_string(),
                    captured_at: at.to_string(),
                },
            ),
            BridgeEventPayload::UsageProbe { .. }
        );
        check!(
            BridgeEvent::roadmap(
                "e",
                at,
                from_json!(RoadmapSnapshot, {
                    "found": false,
                    "source": "",
                    "lanes": []
                }),
            ),
            BridgeEventPayload::Roadmap { .. }
        );
        check!(
            BridgeEvent::check_result(
                "e",
                at,
                from_json!(CheckOutcome, {
                    "root": "C:/work",
                    "check": "npm-test",
                    "command": "npm test",
                    "ok": true,
                    "disposition": "ran",
                    "exitCode": 0,
                    "output": "all good",
                    "truncated": false
                }),
            ),
            BridgeEventPayload::CheckResult { .. }
        );
    }
}
