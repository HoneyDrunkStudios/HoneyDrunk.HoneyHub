pub mod adapter;
pub mod artifact;
pub mod core;
pub mod pairing;
pub mod process;
pub mod session;
pub mod wire;

pub use adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
pub use artifact::{ArtifactKind, DispatchArtifact};
pub use core::{BridgeRuntime, ManagedRun, ReplyOutcome};
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
pub use wire::{
    BridgeEvent, BridgeEventPayload, BridgeStatusEvent, ClientCommand, ReconnectRequest, WireFrame,
    WireFrameKind, WIRE_PROTOCOL_VERSION,
};
