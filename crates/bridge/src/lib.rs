pub mod adapter;
pub mod artifact;
pub mod pairing;
pub mod process;
pub mod session;

pub use adapter::{
    AgentBackend, AgentBackendAdapter, BridgeError, CapabilityFlags, RunHandle, StartRunRequest,
};
pub use artifact::{ArtifactKind, DispatchArtifact};
pub use pairing::{BackendAllowlist, BridgeIdentity, WorkspaceAllowlist};
pub use process::ProcessHandle;
pub use session::{
    DispatchControlEvent, DispatchControlEventKind, DispatchMessage, DispatchMessageRole,
    DispatchRun, DispatchRunState, DispatchSession, PolicyHint, PolicyHintSeverity,
    UsageConfidence, UsageFidelity, UsageSignal,
};
