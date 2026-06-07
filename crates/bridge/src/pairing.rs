use std::path::Path;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn allowlist_accepts_root_or_descendant_only() {
        let root = std::env::temp_dir().join(format!("honeyhub-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        let child = workspace.join("crates").join("bridge");
        let outside = root.join("outside");
        fs::create_dir_all(&child).expect("child workspace is created");
        fs::create_dir_all(&outside).expect("outside workspace is created");

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
}
