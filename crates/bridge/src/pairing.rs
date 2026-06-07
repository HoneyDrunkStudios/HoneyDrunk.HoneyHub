use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackendAllowlist {
    backends: Vec<String>,
}

impl BackendAllowlist {
    pub fn new(backends: Vec<String>) -> Self {
        Self { backends }
    }

    pub fn backends(&self) -> &[String] {
        &self.backends
    }
}
