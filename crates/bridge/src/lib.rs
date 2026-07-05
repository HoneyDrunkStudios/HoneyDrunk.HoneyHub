pub mod activity;
pub mod adapter;
pub mod adapters;
pub mod agents;
pub mod artifact;
pub mod attachments;
pub mod azcli;
pub mod backend_catalog;
pub mod checks;
pub mod clock;
pub mod coaching;
pub mod contentsearch;
pub mod core;
pub mod dispatch;
pub mod environment;
pub mod fsbrowse;
pub mod git;
pub mod grafana;
pub mod jobs;
pub mod keyvault;
pub mod lsp;
pub mod network;
pub mod notify;
pub mod pairing;
pub mod process;
pub mod roadmap;
pub mod sentry;
pub mod servicebus;
pub mod session;
pub mod store;
pub mod usage_probe;
pub mod wire;
pub mod work;

pub use activity::{ActivityKind, DispatchActivity};
pub use adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, ChatAttachment, RunHandle,
    StartRunRequest,
};
pub use adapters::{
    default_event_clock, ClaudeLocalAdapter, CodexLocalAdapter, CopilotLocalAdapter, EventClock,
};
pub use agents::{
    discover_agents_in_root, discover_raw_global_in, discover_raw_in_root, merge_agents, user_home,
    AgentBackendBinding, AgentDefinition, AgentScope, RawAgent, GLOBAL_LABEL,
};
pub use artifact::{ArtifactKind, DispatchArtifact};
pub use attachments::{append_attachment_refs, attachment_dir, write_attachments};
pub use backend_catalog::{
    detect_default_backends, detect_one, model_rate_table, parse_model_rates, program_on_path,
    resolve_program, BackendCapability, BackendModel, ModelPricing, ModelSource,
};
pub use checks::{
    parse_extra_checks, resolve_check, run_check, CheckDenialReason, CheckDisposition, CheckOutcome,
};
pub use coaching::{coach, CoachingSnapshot};
pub use contentsearch::{
    search_content, ContentMatch, ContentSearchEngine, ContentSearchOptions, ContentSearchResults,
};
pub use core::{BridgeRuntime, ManagedRun, ReplyOutcome};
pub use dispatch::{
    audit_dispatch, backend_id, child_cap_from_env, dispatch_backends_from_env, parse_backend,
    summarize_task, DispatchAdmission, DispatchCaller, DispatchDenial, DispatchDenialReason,
    DispatchGovernor, DEFAULT_CHILD_CAP, DISPATCH_SERVER_NAME,
};
pub use environment::{detect_environment, BackendVersion, EnvironmentInfo};
pub use fsbrowse::{
    browse_dir, is_workspace_file, read_file, resolve_workspace_file, search_files, write_file,
    DirEntry, DirEntryKind, DirListing, FileContents, FileWriteResult, SearchHit, SearchResults,
    WorkspaceFolders,
};
pub use git::{
    branches as git_branches, checkout as git_checkout, commit as git_commit,
    delete_branch as git_delete_branch, diff as git_diff, discard as git_discard,
    discard_all as git_discard_all, discover_repos as git_discover_repos,
    file_versions as git_file_versions, overview as git_overview, pull as git_pull,
    push as git_push, stage as git_stage, status as git_status, unstage as git_unstage,
    GitBranches, GitDiff, GitFileStatus, GitFileVersions, GitOpResult, GitOverview, GitStatus,
};
pub use grafana::{summary as grafana_summary, GrafanaDashboard, GrafanaSummary};
pub use jobs::{
    snapshot as job_snapshot, JobProbe, JobSnapshot, KnownJob, ProcessInfo, ScheduledTask,
};
pub use keyvault::{
    list_vault_objects as vault_objects, list_vaults as key_vaults, reveal_secret,
    scan_expiring as scan_key_vault_expiry, subscriptions as azure_subscriptions,
    AzureSubscription, AzureSubscriptionList, ExpiringObject, ExpiringObjects, KeyVault,
    KeyVaultList, SecretReveal, VaultObject, VaultObjectKind, VaultObjects,
};
pub use lsp::{LspServer, LspStatus, ServerSpec};
pub use network::{reachable_addresses, NetAddress, NetAddressKind, NetworkInfo};
pub use notify::{
    notification_for_artifact, notification_for_state, Notification, NotificationCenter,
    NotificationKind, Notifier, RunNotificationContext,
};
pub use pairing::{
    BackendAllowlist, BridgeIdentity, BridgeTrustConfig, PairedDeviceView, PairingGrant,
    PairingRegistry, WorkspaceAllowlist,
};
pub use process::{redact_command_line, ProcessExitStatus, ProcessHandle};
pub use roadmap::{
    pull_architecture, read_roadmap, scaffold_architecture, RoadmapItem, RoadmapLane,
    RoadmapSnapshot,
};
pub use sentry::{summary as sentry_summary, SentryIssue, SentrySummary};
pub use servicebus::{
    list_entities as service_bus_entities, manage as service_bus_manage, peek as service_bus_peek,
    purge as service_bus_purge, receive_one as service_bus_receive,
    resubmit_dead_letter as service_bus_resubmit, send as service_bus_send,
    snapshot as service_bus_snapshot, PeekMessage, SbEntityProps, SbQueue, SbSubscription, SbTopic,
    ServiceBusEntities, ServiceBusEntity, ServiceBusEntityKind, ServiceBusManage,
    ServiceBusNamespace, ServiceBusPeek, ServiceBusPurge, ServiceBusReceive, ServiceBusResubmit,
    ServiceBusSend, ServiceBusSnapshot,
};
pub use session::{
    DispatchControlEvent, DispatchControlEventKind, DispatchMessage, DispatchMessageRole,
    DispatchRun, DispatchRunRecord, DispatchRunState, DispatchSession, PolicyHint,
    PolicyHintSeverity, UsageConfidence, UsageFidelity, UsageRollup, UsageSignal, UsageSummary,
};
pub use store::{LocalStore, StoreError};
pub use usage_probe::{probe_usage, UsageProbeReport, UsageWindow};
pub use wire::{
    BridgeEvent, BridgeEventPayload, BridgeStatusEvent, ClientCommand, ReconnectRequest, WireFrame,
    WireFrameKind, WIRE_PROTOCOL_VERSION,
};
pub use work::{snapshot as work_snapshot, WorkItem, WorkItemKind, WorkSnapshot, WorkSource};
