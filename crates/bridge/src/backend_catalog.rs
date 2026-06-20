//! Backend (provider) detection + model enumeration (packet 09 §3 / ADR-0092).
//!
//! The cockpit webview cannot see the local machine, so "which CLIs do I have?"
//! has to be answered by the bridge. This module probes each known backend's
//! default program on `PATH` and reports a [`BackendCapability`] per backend: is
//! it installed, what models does it expose, and its honest capability flags.
//!
//! Provenance note: where a CLI exposes its own model list we read THAT (so the
//! list is real and current), and tag it so the UI is honest about the source:
//! - Codex caches its models at `~/.codex/models_cache.json` → [`ModelSource::CliCache`].
//! - Claude's selectable set is its canonical aliases (`opus`/`sonnet`/`haiku`),
//!   the same ones its `/model` picker uses → [`ModelSource::CliAlias`].
//!
//! A small bridge-known seed ([`ModelSource::BridgeKnown`]) is only the fallback when
//! a CLI's real source can't be read. Installation is always detected live on PATH.
//!
//! Copilot is intentionally **not** surfaced by [`detect_default_backends`]: it caches
//! no model list on disk (its `/model` picker fetches from GitHub with the user's auth
//! at runtime), and reading/using that auth is out of scope (`[Firm]` BYOK-only). The
//! enum variant + adapter remain for the backend abstraction; they are just not offered.

use crate::adapter::{AgentBackend, CapabilityFlags};
use serde::{Deserialize, Serialize};

/// One model a backend can run, as offered to the user in the model picker. `id`
/// is the value passed to the CLI (e.g. `--model <id>`); `label` is human-facing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendModel {
    pub id: String,
    pub label: String,
    /// Reasoning-effort levels this model supports (e.g. `low`/`medium`/`high`), when the
    /// CLI exposes them (Codex's cache does; Claude has no effort flag). Empty = none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_levels: Vec<String>,
    /// The CLI's default reasoning level for this model, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning: Option<String>,
}

impl BackendModel {
    fn new(id: &str, label: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            reasoning_levels: Vec::new(),
            default_reasoning: None,
        }
    }
}

/// How the model list was sourced — so the UI is honest about provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    /// Read from the CLI's own on-disk model cache (e.g. Codex's `models_cache.json`).
    CliCache,
    /// The CLI's canonical model aliases (e.g. Claude's `opus`/`sonnet`/`haiku`).
    CliAlias,
    /// A curated, bridge-known fallback (used only when a real source can't be read).
    BridgeKnown,
}

/// A single backend's detected capability: whether its CLI is installed, the models
/// it offers, and its honest capability flags. Reported to the cockpit so the
/// first-run provider picker and the run-screen model picker show only what's real.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapability {
    pub backend: AgentBackend,
    /// The program name probed on `PATH` (e.g. `claude`).
    pub program: String,
    /// True when the program resolves on `PATH` (or is an existing path).
    pub available: bool,
    /// The honest capability flags for this backend (streaming, reply mode, usage
    /// fidelity, …) — the same handshake profile the adapter declares.
    pub capabilities: CapabilityFlags,
    /// Models offered for this backend (see [`ModelSource`] for provenance).
    pub models: Vec<BackendModel>,
    /// The model used when the user does not pick one (the CLI's own default when
    /// `None`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub model_source: ModelSource,
}

/// The default program name probed for a backend.
pub fn default_program(backend: AgentBackend) -> &'static str {
    match backend {
        AgentBackend::ClaudeLocal => "claude",
        AgentBackend::CodexLocal => "codex",
        AgentBackend::CopilotLocal => "copilot",
    }
}

/// Resolve the models offered for a backend, with provenance. Reads each CLI's real
/// source where one exists, falling back to a conservative bridge-known seed.
fn models_for(backend: AgentBackend) -> (Vec<BackendModel>, ModelSource) {
    match backend {
        // Claude's selectable set is its canonical aliases (latest of each family).
        AgentBackend::ClaudeLocal => (
            vec![
                BackendModel::new("opus", "Claude Opus 4.8"),
                BackendModel::new("sonnet", "Claude Sonnet 4.6"),
                BackendModel::new("haiku", "Claude Haiku 4.5"),
            ],
            ModelSource::CliAlias,
        ),
        // Codex caches its real model list; read it, else fall back to a seed.
        AgentBackend::CodexLocal => match codex_cached_models() {
            Some(models) if !models.is_empty() => (models, ModelSource::CliCache),
            _ => (
                vec![BackendModel::new("gpt-5-codex", "GPT-5 Codex")],
                ModelSource::BridgeKnown,
            ),
        },
        // Not surfaced by default detection (see module note); seed for completeness.
        AgentBackend::CopilotLocal => (
            vec![BackendModel::new("auto", "Copilot (auto)")],
            ModelSource::BridgeKnown,
        ),
    }
}

fn capabilities_for(backend: AgentBackend) -> CapabilityFlags {
    match backend {
        AgentBackend::ClaudeLocal => CapabilityFlags::claude_local(),
        AgentBackend::CodexLocal => CapabilityFlags::codex_local(),
        AgentBackend::CopilotLocal => CapabilityFlags::copilot_local(),
    }
}

/// Read Codex's on-disk model cache (`~/.codex/models_cache.json`) into models.
/// Returns `None` if the file is absent/unreadable/unparseable.
fn codex_cached_models() -> Option<Vec<BackendModel>> {
    let path = crate::agents::user_home()?
        .join(".codex")
        .join("models_cache.json");
    let text = std::fs::read_to_string(path).ok()?;
    let models = parse_codex_models(&text);
    (!models.is_empty()).then_some(models)
}

/// Parse Codex's `models_cache.json` into models (`slug` → id, `display_name` →
/// label), preserving cache order. Returns empty on any parse failure (the caller
/// then falls back to the seed).
pub fn parse_codex_models(json: &str) -> Vec<BackendModel> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let slug = model.get("slug").and_then(|s| s.as_str())?;
            let label = model
                .get("display_name")
                .and_then(|d| d.as_str())
                .unwrap_or(slug);
            let mut backend_model = BackendModel::new(slug, label);
            backend_model.reasoning_levels = model
                .get("supported_reasoning_levels")
                .and_then(|levels| levels.as_array())
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            backend_model.default_reasoning = model
                .get("default_reasoning_level")
                .and_then(|level| level.as_str())
                .map(str::to_string);
            Some(backend_model)
        })
        .collect()
}

/// Detect a single backend by probing its (possibly overridden) program on `PATH`.
pub fn detect_one(backend: AgentBackend, program: &str) -> BackendCapability {
    let (models, model_source) = models_for(backend);
    BackendCapability {
        backend,
        program: program.to_string(),
        available: program_on_path(program),
        capabilities: capabilities_for(backend),
        models,
        default_model: None,
        model_source,
    }
}

/// Detect the surfaced backends (Claude + Codex) using each one's default program
/// name. Always returns one entry per backend (available or not) so the UI can show
/// the set and mark which are installed. Copilot is intentionally excluded (see the
/// module note).
pub fn detect_default_backends() -> Vec<BackendCapability> {
    [AgentBackend::ClaudeLocal, AgentBackend::CodexLocal]
        .into_iter()
        .map(|backend| detect_one(backend, default_program(backend)))
        .collect()
}

/// Resolve whether an executable named `program` exists on `PATH`. A name that
/// already contains a path separator (or is absolute) is checked directly. On
/// Windows the `PATHEXT` extensions are tried in addition to the bare name.
pub fn program_on_path(program: &str) -> bool {
    if program.is_empty() {
        return false;
    }
    let direct = std::path::Path::new(program);
    if direct.is_absolute() || program.contains('/') || program.contains('\\') {
        return direct.is_file();
    }

    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let extensions = windows_path_extensions();
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if dir.join(program).is_file() {
            return true;
        }
        for ext in &extensions {
            if dir.join(format!("{program}{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}

/// The executable extensions to try on Windows (from `PATHEXT`), or none elsewhere.
fn windows_path_extensions() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(|ext| {
            if ext.starts_with('.') {
                ext.to_string()
            } else {
                format!(".{ext}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_claude_and_codex_only() {
        let catalog = detect_default_backends();
        assert_eq!(catalog.len(), 2);
        let backends: Vec<AgentBackend> = catalog.iter().map(|entry| entry.backend).collect();
        assert!(backends.contains(&AgentBackend::ClaudeLocal));
        assert!(backends.contains(&AgentBackend::CodexLocal));
        assert!(!backends.contains(&AgentBackend::CopilotLocal));
    }

    #[test]
    fn each_entry_carries_models_and_capabilities() {
        for entry in detect_default_backends() {
            assert!(!entry.models.is_empty(), "{:?} has models", entry.backend);
            assert_eq!(entry.program, default_program(entry.backend));
        }
        let claude = detect_one(AgentBackend::ClaudeLocal, "claude");
        assert!(claude.capabilities.usage_exact);
        assert_eq!(claude.model_source, ModelSource::CliAlias);
    }

    #[test]
    fn parses_codex_models_from_cache_json() {
        let json = r#"{
            "fetched_at": "2026-06-14T00:00:00Z",
            "models": [
                { "slug": "gpt-5.5", "display_name": "GPT-5.5" },
                { "slug": "gpt-5.4-mini", "display_name": "GPT-5.4-Mini" },
                { "slug": "no-label" }
            ]
        }"#;
        let models = parse_codex_models(json);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0], BackendModel::new("gpt-5.5", "GPT-5.5"));
        assert_eq!(models[1], BackendModel::new("gpt-5.4-mini", "GPT-5.4-Mini"));
        // Missing display_name falls back to the slug.
        assert_eq!(models[2], BackendModel::new("no-label", "no-label"));
    }

    #[test]
    fn parses_codex_models_handles_garbage() {
        assert!(parse_codex_models("not json").is_empty());
        assert!(parse_codex_models("{}").is_empty());
    }

    #[test]
    fn parses_codex_reasoning_levels_when_present() {
        let json = r#"{
            "models": [
                {
                    "slug": "gpt-5-codex",
                    "display_name": "GPT-5 Codex",
                    "supported_reasoning_levels": ["low", "medium", "high"],
                    "default_reasoning_level": "medium"
                },
                { "slug": "plain", "display_name": "Plain" }
            ]
        }"#;
        let models = parse_codex_models(json);
        assert_eq!(models[0].reasoning_levels, vec!["low", "medium", "high"]);
        assert_eq!(models[0].default_reasoning.as_deref(), Some("medium"));
        // A model without the fields gets an empty level set + no default.
        assert!(models[1].reasoning_levels.is_empty());
        assert_eq!(models[1].default_reasoning, None);
    }

    #[test]
    fn missing_program_is_not_available() {
        let entry = detect_one(
            AgentBackend::ClaudeLocal,
            "definitely-not-a-real-program-xyz-123",
        );
        assert!(!entry.available);
    }

    #[test]
    fn empty_program_is_not_on_path() {
        assert!(!program_on_path(""));
    }
}
