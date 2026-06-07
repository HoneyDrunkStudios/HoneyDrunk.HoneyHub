use crate::adapter::{AgentBackend, BridgeError};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

/// The bridge's own per-device identity, generated once on first run and
/// persisted in local bridge config (ADR-0090 D8). It is local-only and never
/// streamed into a HoneyHub transcript or notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeIdentity {
    pub device_id: Uuid,
    pub display_name: String,
}

impl BridgeIdentity {
    pub fn new(display_name: impl Into<String>) -> Self {
        Self {
            device_id: Uuid::new_v4(),
            display_name: display_name.into(),
        }
    }
}

/// A client device paired to this bridge. The pairing `token` is the secret the
/// PWA presents on every wire-protocol connection; it lives only in local bridge
/// config (ADR-0090 D11 local-only classification) and is never serialized into a
/// transcript, notification, or any sync surface.
///
/// This type is **crate-private** on purpose: it carries the plaintext token, so
/// downstream code never gets a handle that could be accidentally logged or
/// serialized onto a sync surface. The public API only ever hands out the
/// token-free [`PairedDeviceView`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairedDevice {
    pub device_id: Uuid,
    pub display_name: String,
    pub token: String,
    pub paired_at: String,
    pub revoked: bool,
}

/// A redacted, transcript/notification-safe view of a paired device. It carries
/// no token, so it is the only shape that may cross a sync surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceView {
    pub device_id: Uuid,
    pub display_name: String,
    pub paired_at: String,
    pub revoked: bool,
}

impl From<&PairedDevice> for PairedDeviceView {
    fn from(device: &PairedDevice) -> Self {
        Self {
            device_id: device.device_id,
            display_name: device.display_name.clone(),
            paired_at: device.paired_at.clone(),
            revoked: device.revoked,
        }
    }
}

/// The result of a successful pairing handshake. The plaintext `token` is
/// returned here exactly once — the caller shows it to the client device and
/// must not persist or display it again (ADR-0090 D8 no-secret-leak posture).
/// It serializes as the handshake response the client receives over the wire;
/// after that single hop the token is never re-surfaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingGrant {
    pub device: PairedDeviceView,
    pub token: String,
}

/// The bridge trust boundary (ADR-0090 D8): a per-device identity plus the set of
/// paired client devices and their revocable tokens. Packet 04's wire protocol
/// rides the token; the runtime launch-gate rides the allowlists below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRegistry {
    identity: BridgeIdentity,
    devices: Vec<PairedDevice>,
}

impl PairingRegistry {
    pub fn new(identity: BridgeIdentity) -> Self {
        Self {
            identity,
            devices: Vec::new(),
        }
    }

    pub fn identity(&self) -> &BridgeIdentity {
        &self.identity
    }

    /// Visible (token-free) views of every paired device, safe to surface in the
    /// PWA settings UI or a notification.
    pub fn device_views(&self) -> Vec<PairedDeviceView> {
        self.devices.iter().map(PairedDeviceView::from).collect()
    }

    /// User-initiated pairing handshake: registers a new client device and issues
    /// a fresh revocable token. The plaintext token is returned exactly once in
    /// the [`PairingGrant`]; thereafter only its hash-free presence is observable.
    pub fn pair(
        &mut self,
        display_name: impl Into<String>,
        paired_at: impl Into<String>,
    ) -> PairingGrant {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let device = PairedDevice {
            device_id: Uuid::new_v4(),
            display_name: display_name.into(),
            token: token.clone(),
            paired_at: paired_at.into(),
            revoked: false,
        };
        let view = PairedDeviceView::from(&device);
        self.devices.push(device);
        PairingGrant {
            device: view,
            token,
        }
    }

    /// Verify a token presented on a wire-protocol connection. Returns a
    /// token-free view of the paired device only when the token matches an active
    /// (non-revoked) pairing; a revoked or unknown token is rejected. The view
    /// shape means a caller can identify the device without ever holding the
    /// secret.
    pub fn verify(&self, token: &str) -> Option<PairedDeviceView> {
        self.find_active(token).map(PairedDeviceView::from)
    }

    pub fn is_authorized(&self, token: &str) -> bool {
        self.find_active(token).is_some()
    }

    fn find_active(&self, token: &str) -> Option<&PairedDevice> {
        // Full scan with no early return so verification time does not depend on
        // which device matches (or whether an earlier device mismatched) — the
        // constant-time posture extends from the byte compare to the device walk.
        self.devices.iter().fold(None, |matched, device| {
            if !device.revoked && constant_time_eq(&device.token, token) {
                Some(device)
            } else {
                matched
            }
        })
    }

    /// Revoke a paired device by id. A revoked device's token is rejected by
    /// [`verify`] from this point on. Revoking an unknown device is an error so
    /// the UI can report it rather than silently no-op.
    pub fn revoke(&mut self, device_id: Uuid) -> Result<(), BridgeError> {
        match self
            .devices
            .iter_mut()
            .find(|device| device.device_id == device_id)
        {
            Some(device) => {
                device.revoked = true;
                Ok(())
            }
            None => Err(BridgeError::new(
                "device_not_found",
                format!("no paired device with id {device_id}"),
            )),
        }
    }
}

/// Compare two secrets without short-circuiting on the first differing byte or on
/// a length mismatch, so a token check does not leak prefix or length information
/// through timing. A length difference is folded into the accumulator rather than
/// returned early, and the loop runs over the longer input.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = (left.len() ^ right.len()) as u64;
    let len = left.len().max(right.len());
    for index in 0..len {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        diff |= u64::from(a ^ b);
    }
    diff == 0
}

/// The user-configured list of absolute workspace roots the bridge may operate
/// within (ADR-0090 D8). The bridge refuses to launch any process against a path
/// outside it. Absolute paths are stored because the bridge needs them to gate
/// launches, but the allowlist is local-only and is NEVER synced off the bridge
/// host (ADR-0090 D11) — only repo-relative derivations may cross a sync surface.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceAllowlist {
    roots: Vec<String>,
}

impl WorkspaceAllowlist {
    pub fn new(roots: Vec<String>) -> Self {
        Self { roots }
    }

    pub fn roots(&self) -> &[String] {
        &self.roots
    }

    /// Add an absolute workspace root. Returns an error for a relative path (the
    /// bridge cannot gate launches against a non-absolute root) or a duplicate.
    pub fn add_root(&mut self, root: impl Into<String>) -> Result<(), BridgeError> {
        let root = root.into();
        if !Path::new(&root).is_absolute() {
            return Err(BridgeError::new(
                "workspace_not_allowed",
                "workspace root must be an absolute path",
            ));
        }
        if self.roots.iter().any(|existing| existing == &root) {
            return Err(BridgeError::new(
                "duplicate_workspace_root",
                "workspace root is already on the allowlist",
            ));
        }
        self.roots.push(root);
        Ok(())
    }

    /// Remove a workspace root. Returns an error if it was not present, so the UI
    /// can report it rather than silently no-op.
    pub fn remove_root(&mut self, root: &str) -> Result<(), BridgeError> {
        let before = self.roots.len();
        self.roots.retain(|existing| existing != root);
        if self.roots.len() == before {
            Err(BridgeError::new(
                "workspace_root_not_found",
                "workspace root is not on the allowlist",
            ))
        } else {
            Ok(())
        }
    }

    pub fn allows(&self, workspace_root: &str) -> bool {
        let workspace_path = Path::new(workspace_root);
        if !workspace_path.is_absolute() {
            return false;
        }
        let Ok(workspace) = workspace_path.canonicalize() else {
            return false;
        };

        self.roots.iter().any(|root| {
            let root_path = Path::new(root);
            if !root_path.is_absolute() {
                return false;
            }
            let Ok(root) = root_path.canonicalize() else {
                return false;
            };
            workspace == root || workspace.starts_with(root)
        })
    }
}

/// The user-controlled list of backends the bridge may launch (ADR-0090 D8). At
/// v1 only `claude.local` has an adapter (packet 06), but the allowlist is the
/// seam that keeps future adapters opt-in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BackendAllowlist {
    backends: Vec<AgentBackend>,
}

impl BackendAllowlist {
    pub fn new(backends: Vec<AgentBackend>) -> Self {
        Self { backends }
    }

    pub fn backends(&self) -> &[AgentBackend] {
        &self.backends
    }

    pub fn allows(&self, backend: &AgentBackend) -> bool {
        self.backends.contains(backend)
    }

    /// Allow a backend. Adding an already-allowed backend is an error so the UI
    /// can report it rather than silently no-op.
    pub fn add(&mut self, backend: AgentBackend) -> Result<(), BridgeError> {
        if self.backends.contains(&backend) {
            return Err(BridgeError::new(
                "duplicate_backend",
                "backend is already on the allowlist",
            ));
        }
        self.backends.push(backend);
        Ok(())
    }

    /// Disallow a backend. Removing a backend that was not allowed is an error.
    pub fn remove(&mut self, backend: &AgentBackend) -> Result<(), BridgeError> {
        let before = self.backends.len();
        self.backends.retain(|existing| existing != backend);
        if self.backends.len() == before {
            Err(BridgeError::new(
                "backend_not_found",
                "backend is not on the allowlist",
            ))
        } else {
            Ok(())
        }
    }
}

/// The full local bridge trust configuration: the pairing registry plus the two
/// allowlists. This is the unit packet 07's store persists; it serializes whole,
/// and (being local-only) may contain absolute paths and tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTrustConfig {
    pub pairing: PairingRegistry,
    pub workspace_allowlist: WorkspaceAllowlist,
    pub backend_allowlist: BackendAllowlist,
}

impl BridgeTrustConfig {
    pub fn new(identity: BridgeIdentity) -> Self {
        Self {
            pairing: PairingRegistry::new(identity),
            workspace_allowlist: WorkspaceAllowlist::default(),
            backend_allowlist: BackendAllowlist::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_root_or_descendant_only() {
        let root = tempfile::TempDir::new().expect("temp root is created");
        let root = root.path();
        let workspace = root.join("workspace");
        let child = workspace.join("crates").join("bridge");
        let outside = root.join("outside");
        std::fs::create_dir_all(&child).expect("child workspace is created");
        std::fs::create_dir_all(&outside).expect("outside workspace is created");

        let allowlist = WorkspaceAllowlist::new(vec![workspace.to_string_lossy().to_string()]);

        assert!(allowlist.allows(&workspace.to_string_lossy()));
        assert!(allowlist.allows(
            &workspace
                .join(".")
                .join("crates")
                .join("bridge")
                .to_string_lossy()
        ));
        assert!(allowlist.allows(&child.to_string_lossy()));
        assert!(!allowlist.allows(&outside.to_string_lossy()));
        assert!(!allowlist.allows(&workspace.join("..").join("outside").to_string_lossy()));
        assert!(!allowlist.allows("relative/workspace"));
    }

    #[test]
    fn workspace_allowlist_add_and_remove_are_explicit() {
        let root = tempfile::TempDir::new().expect("temp root is created");
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir_all(&first).expect("first is created");
        std::fs::create_dir_all(&second).expect("second is created");
        let first = first.to_string_lossy().to_string();
        let second = second.to_string_lossy().to_string();

        let mut allowlist = WorkspaceAllowlist::default();
        allowlist.add_root(first.clone()).expect("first root added");
        allowlist
            .add_root(second.clone())
            .expect("second root added");
        assert_eq!(allowlist.roots().len(), 2);

        let duplicate = allowlist
            .add_root(first.clone())
            .expect_err("duplicate root rejected");
        assert_eq!(duplicate.code, "duplicate_workspace_root");

        let relative = allowlist
            .add_root("relative/path")
            .expect_err("relative root rejected");
        assert_eq!(relative.code, "workspace_not_allowed");

        allowlist.remove_root(&first).expect("first root removed");
        let missing = allowlist
            .remove_root(&first)
            .expect_err("removing absent root errors");
        assert_eq!(missing.code, "workspace_root_not_found");
        assert_eq!(allowlist.roots(), &[second]);
    }

    #[test]
    fn backend_allowlist_gates_membership_with_explicit_errors() {
        let mut allowlist = BackendAllowlist::default();
        assert!(!allowlist.allows(&AgentBackend::ClaudeLocal));

        allowlist
            .add(AgentBackend::ClaudeLocal)
            .expect("claude added");
        assert!(allowlist.allows(&AgentBackend::ClaudeLocal));
        assert!(!allowlist.allows(&AgentBackend::CodexLocal));

        let duplicate = allowlist
            .add(AgentBackend::ClaudeLocal)
            .expect_err("duplicate backend rejected");
        assert_eq!(duplicate.code, "duplicate_backend");

        allowlist
            .remove(&AgentBackend::ClaudeLocal)
            .expect("claude removed");
        let missing = allowlist
            .remove(&AgentBackend::ClaudeLocal)
            .expect_err("removing absent backend errors");
        assert_eq!(missing.code, "backend_not_found");
    }

    #[test]
    fn pairing_issues_a_verifiable_revocable_token() {
        let mut registry = PairingRegistry::new(BridgeIdentity::new("bridge-host"));
        let grant = registry.pair("Pixel phone", "2026-06-07T12:00:00Z");

        assert!(!grant.token.is_empty());
        assert!(registry.is_authorized(&grant.token));
        assert_eq!(
            registry
                .verify(&grant.token)
                .expect("token verifies")
                .device_id,
            grant.device.device_id
        );

        registry
            .revoke(grant.device.device_id)
            .expect("device revoked");
        assert!(!registry.is_authorized(&grant.token));
        assert!(registry.verify(&grant.token).is_none());
    }

    #[test]
    fn pairing_rejects_unknown_tokens_and_unknown_revocations() {
        let mut registry = PairingRegistry::new(BridgeIdentity::new("bridge-host"));
        let grant = registry.pair("Laptop", "2026-06-07T12:00:00Z");

        assert!(!registry.is_authorized("not-a-real-token"));
        assert!(!registry.is_authorized(""));

        let missing = registry
            .revoke(Uuid::new_v4())
            .expect_err("revoking unknown device errors");
        assert_eq!(missing.code, "device_not_found");
        assert!(registry.is_authorized(&grant.token));
    }

    #[test]
    fn each_pairing_issues_a_distinct_token() {
        let mut registry = PairingRegistry::new(BridgeIdentity::new("bridge-host"));
        let first = registry.pair("Phone", "2026-06-07T12:00:00Z");
        let second = registry.pair("Tablet", "2026-06-07T12:01:00Z");

        assert_ne!(first.token, second.token);
        assert_ne!(first.device.device_id, second.device.device_id);
        assert!(registry.is_authorized(&first.token));
        assert!(registry.is_authorized(&second.token));
    }

    #[test]
    fn device_views_never_carry_the_token() {
        let mut registry = PairingRegistry::new(BridgeIdentity::new("bridge-host"));
        let grant = registry.pair("Phone", "2026-06-07T12:00:00Z");

        let views = registry.device_views();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].device_id, grant.device.device_id);
        // A serialized view must not leak the token onto a sync surface.
        let serialized = serde_json::to_string(&views[0]).expect("view serializes");
        assert!(!serialized.contains(&grant.token));
        assert!(!serialized.contains("token"));
    }

    #[test]
    fn trust_config_round_trips_through_serde() {
        let mut config = BridgeTrustConfig::new(BridgeIdentity::new("bridge-host"));
        let root = tempfile::TempDir::new().expect("temp root is created");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace is created");
        config
            .workspace_allowlist
            .add_root(workspace.to_string_lossy().to_string())
            .expect("root added");
        config
            .backend_allowlist
            .add(AgentBackend::ClaudeLocal)
            .expect("backend added");
        config.pairing.pair("Phone", "2026-06-07T12:00:00Z");

        let json = serde_json::to_string(&config).expect("config serializes");
        let restored: BridgeTrustConfig = serde_json::from_str(&json).expect("config deserializes");
        assert_eq!(restored, config);
    }
}
