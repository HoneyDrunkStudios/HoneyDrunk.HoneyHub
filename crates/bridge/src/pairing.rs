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

    pub fn allows(&self, workspace_root: &str) -> bool {
        let Some(workspace) = normalize_path_text(workspace_root) else {
            return false;
        };

        self.roots.iter().any(|root| {
            let Some(root) = normalize_path_text(root) else {
                return false;
            };
            !root.is_empty() && (workspace == root || workspace.starts_with(&format!("{root}/")))
        })
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

fn normalize_path_text(path: &str) -> Option<String> {
    let trimmed = path.trim().replace('\\', "/");
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        parts.push(part);
    }

    let normalized = parts.join("/");
    if cfg!(windows) {
        Some(normalized.to_ascii_lowercase())
    } else {
        Some(normalized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_root_or_descendant_only() {
        let allowlist = WorkspaceAllowlist::new(vec!["C:/work/honeyhub".to_string()]);

        assert!(allowlist.allows("C:/work/honeyhub"));
        assert!(allowlist.allows("C:/work/honeyhub/./crates/bridge"));
        assert!(allowlist.allows("C:/work/honeyhub/crates/bridge"));
        assert!(!allowlist.allows("C:/work/honeyhub-other"));
        assert!(!allowlist.allows("C:/work/honeyhub/../other"));
        assert!(!allowlist.allows("C:/work/other"));
    }
}
