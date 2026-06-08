pub mod adapter;
pub mod adapters;
pub mod artifact;
pub mod clock;
pub mod core;
pub mod notify;
pub mod pairing;
pub mod process;
pub mod session;
pub mod store;
pub mod wire;

pub use adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
pub use adapters::{default_event_clock, ClaudeLocalAdapter, EventClock};
pub use artifact::{ArtifactKind, DispatchArtifact};
pub use core::{BridgeRuntime, ManagedRun, ReplyOutcome};
pub use notify::{
    notification_for_artifact, notification_for_state, Notification, NotificationCenter,
    NotificationKind, Notifier, RunNotificationContext,
};
pub use pairing::{
    BackendAllowlist, BridgeIdentity, BridgeTrustConfig, PairedDeviceView, PairingGrant,
    PairingRegistry, WorkspaceAllowlist,
};
pub use process::{redact_command_line, ProcessExitStatus, ProcessHandle};
pub use session::{
    DispatchControlEvent, DispatchControlEventKind, DispatchMessage, DispatchMessageRole,
    DispatchRun, DispatchRunRecord, DispatchRunState, DispatchSession, PolicyHint,
    PolicyHintSeverity, UsageConfidence, UsageFidelity, UsageSignal,
};
pub use store::{LocalStore, StoreError};
pub use wire::{
    BridgeEvent, BridgeEventPayload, BridgeStatusEvent, ClientCommand, ReconnectRequest, WireFrame,
    WireFrameKind, WIRE_PROTOCOL_VERSION,
};
