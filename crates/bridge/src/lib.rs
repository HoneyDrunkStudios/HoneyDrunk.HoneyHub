pub mod activity;
pub mod adapter;
pub mod adapters;
pub mod agents;
pub mod artifact;
pub mod backend_catalog;
pub mod clock;
pub mod coaching;
pub mod core;
pub mod environment;
pub mod fsbrowse;
pub mod git;
pub mod grafana;
pub mod jobs;
pub mod network;
pub mod notify;
pub mod pairing;
pub mod process;
pub mod roadmap;
pub mod sentry;
pub mod servicebus;
pub mod session;
pub mod store;
pub mod wire;
pub mod work;

pub use activity::{ActivityKind, DispatchActivity};
pub use adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
pub use adapters::{
    default_event_clock, ClaudeLocalAdapter, CodexLocalAdapter, CopilotLocalAdapter, EventClock,
};
pub use agents::{
    discover_agents_in_root, discover_raw_global_in, discover_raw_in_root, merge_agents, user_home,
    AgentBackendBinding, AgentDefinition, AgentScope, RawAgent, GLOBAL_LABEL,
};
pub use artifact::{ArtifactKind, DispatchArtifact};
pub use backend_catalog::{
    detect_default_backends, detect_one, program_on_path, BackendCapability, BackendModel,
    ModelSource,
};
pub use coaching::{coach, CoachingSnapshot};
pub use core::{BridgeRuntime, ManagedRun, ReplyOutcome};
pub use environment::{detect_environment, BackendVersion, EnvironmentInfo};
pub use fsbrowse::{
    browse_dir, is_workspace_file, read_file, resolve_workspace_file, search_files, DirEntry,
    DirEntryKind, DirListing, FileContents, SearchHit, SearchResults, WorkspaceFolders,
};
pub use git::{diff as git_diff, status as git_status, GitDiff, GitFileStatus, GitStatus};
pub use grafana::{summary as grafana_summary, GrafanaDashboard, GrafanaSummary};
pub use jobs::{
    snapshot as job_snapshot, JobProbe, JobSnapshot, KnownJob, ProcessInfo, ScheduledTask,
};
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
    peek as service_bus_peek, purge as service_bus_purge, receive_one as service_bus_receive,
    resubmit_dead_letter as service_bus_resubmit, send as service_bus_send,
    snapshot as service_bus_snapshot, PeekMessage, ServiceBusEntity, ServiceBusEntityKind,
    ServiceBusNamespace, ServiceBusPeek, ServiceBusPurge, ServiceBusReceive, ServiceBusResubmit,
    ServiceBusSend, ServiceBusSnapshot,
};
pub use session::{
    DispatchControlEvent, DispatchControlEventKind, DispatchMessage, DispatchMessageRole,
    DispatchRun, DispatchRunRecord, DispatchRunState, DispatchSession, PolicyHint,
    PolicyHintSeverity, UsageConfidence, UsageFidelity, UsageRollup, UsageSignal, UsageSummary,
};
pub use store::{LocalStore, StoreError};
pub use wire::{
    BridgeEvent, BridgeEventPayload, BridgeStatusEvent, ClientCommand, ReconnectRequest, WireFrame,
    WireFrameKind, WIRE_PROTOCOL_VERSION,
};
pub use work::{snapshot as work_snapshot, WorkItem, WorkItemKind, WorkSnapshot, WorkSource};
