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
//! - Claude's selectable set is its canonical aliases (`fable`/`opus`/`sonnet`/`haiku`),
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
use std::collections::HashMap;

/// Per-model USD pricing (per **million** tokens), when the bridge knows an
/// authoritative rate. Powers pre-send estimates and derived cost; absent =
/// unknown, and a cost is never guessed from a missing rate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One model a backend can run, as offered to the user in the model picker. `id`
/// is the value passed to the CLI (e.g. `--model <id>`); `label` is human-facing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Known per-token pricing (see [`ModelPricing`]); absent when the bridge has no
    /// authoritative rate for this model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
    /// True when running this model bills real dollars even on a flat subscription
    /// (usage credits / API metering). The cost optimizer and the composer's
    /// "included in your plan" display must never treat a metered model as free.
    #[serde(default, skip_serializing_if = "is_false")]
    pub metered: bool,
}

impl BackendModel {
    fn new(id: &str, label: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            reasoning_levels: Vec::new(),
            default_reasoning: None,
            pricing: None,
            metered: false,
        }
    }

    fn with_metered(mut self) -> Self {
        self.metered = true;
        self
    }
}

/// How the model list was sourced — so the UI is honest about provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource {
    /// Read from the CLI's own on-disk model cache (e.g. Codex's `models_cache.json`).
    CliCache,
    /// The CLI's canonical model aliases (e.g. Claude's `fable`/`opus`/`sonnet`/`haiku`).
    CliAlias,
    /// A curated, bridge-known fallback (used only when a real source can't be read).
    BridgeKnown,
}

/// A single backend's detected capability: whether its CLI is installed, the models
/// it offers, and its honest capability flags. Reported to the cockpit so the
/// first-run provider picker and the model picker show only what's real.
/// (`PartialEq` only: [`ModelPricing`] carries `f64` rates, so `Eq` cannot hold.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    let (models, source) = match backend {
        // Claude's selectable set is its canonical aliases (latest of each family).
        // Order matters: the cockpit defaults to the FIRST entry when the user hasn't
        // picked, so `opus` stays first; `fable` (usage-credit billed) is opt-in only.
        // No rate is ever coined here (invariant 45): pricing comes solely from the
        // operator's HONEYHUB_MODEL_RATES table below, and actual Claude spend stays
        // exact via the CLI's total_cost_usd regardless.
        AgentBackend::ClaudeLocal => (
            vec![
                BackendModel::new("opus", "Claude Opus 4.8"),
                BackendModel::new("sonnet", "Claude Sonnet 5"),
                BackendModel::new("haiku", "Claude Haiku 4.5"),
                BackendModel::new("fable", "Claude Fable 5").with_metered(),
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
    };
    // Rates attach uniformly to EVERY backend's list (one env read per call), so an
    // operator entry works the same for a cached Codex model, a Claude alias, or a
    // seed row — no per-branch exemptions.
    (priced(models, &model_rate_table()), source)
}

fn capabilities_for(backend: AgentBackend) -> CapabilityFlags {
    match backend {
        AgentBackend::ClaudeLocal => CapabilityFlags::claude_local(),
        AgentBackend::CodexLocal => CapabilityFlags::codex_local(),
        AgentBackend::CopilotLocal => CapabilityFlags::copilot_local(),
    }
}

/// The operator's model rate table, from the `HONEYHUB_MODEL_RATES` env var:
/// `{"<model id or alias>": {"input": <usd per MTok>, "output": <usd per MTok>}, ...}`
/// (e.g. `opus`, `fable`, `gpt-5-codex`). Rates are never coined in application code
/// (invariant 45 / ADR-0092 D2): the operator — or a canonical Grid rate projection
/// feeding this seam — owns vendor prices. Absent or invalid config just means no
/// rates, so costs stay honestly absent rather than guessed.
pub fn model_rate_table() -> HashMap<String, ModelPricing> {
    parse_model_rates(&std::env::var("HONEYHUB_MODEL_RATES").unwrap_or_default())
}

/// Attach the operator's rates (by exact id) to a model list. Models without a
/// configured rate keep `pricing: None`.
fn priced(models: Vec<BackendModel>, rates: &HashMap<String, ModelPricing>) -> Vec<BackendModel> {
    models
        .into_iter()
        .map(|mut model| {
            model.pricing = rates.get(&model.id).copied();
            model
        })
        .collect()
}

/// Parse a `HONEYHUB_MODEL_RATES` JSON document. Entries with a missing or
/// non-positive rate are dropped; any parse failure yields an empty table.
pub fn parse_model_rates(json: &str) -> HashMap<String, ModelPricing> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return HashMap::new();
    };
    let Some(entries) = value.as_object() else {
        return HashMap::new();
    };
    entries
        .iter()
        .filter_map(|(slug, rate)| {
            let input = rate.get("input").and_then(serde_json::Value::as_f64)?;
            let output = rate.get("output").and_then(serde_json::Value::as_f64)?;
            (input > 0.0 && output > 0.0).then(|| {
                (
                    slug.clone(),
                    ModelPricing {
                        input_usd_per_mtok: input,
                        output_usd_per_mtok: output,
                    },
                )
            })
        })
        .collect()
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

/// Resolve `program` to the concrete file to launch. A name that already contains a
/// path separator (or is absolute) is checked directly; otherwise `PATH` is walked,
/// trying the bare name plus the Windows `PATHEXT` extensions — so `npm` resolves to
/// `npm.cmd` and spawns correctly on Windows.
pub fn resolve_program(program: &str) -> Option<std::path::PathBuf> {
    if program.is_empty() {
        return None;
    }
    let direct = std::path::Path::new(program);
    if direct.is_absolute() || program.contains('/') || program.contains('\\') {
        return direct.is_file().then(|| direct.to_path_buf());
    }

    let path = std::env::var_os("PATH")?;
    let extensions = windows_path_extensions();
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let bare = dir.join(program);
        if bare.is_file() {
            return Some(bare);
        }
        for ext in &extensions {
            let with_ext = dir.join(format!("{program}{ext}"));
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

/// Whether an executable named `program` exists on `PATH` (see [`resolve_program`]).
pub fn program_on_path(program: &str) -> bool {
    resolve_program(program).is_some()
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
    fn claude_models_carry_metering_but_never_coined_rates() {
        let claude = detect_one(AgentBackend::ClaudeLocal, "claude");
        // First entry is the picker's default when the user has not chosen — it must
        // stay a plan-included model, never the usage-credit-billed fable.
        assert_eq!(claude.models[0].id, "opus");
        let fable = claude
            .models
            .iter()
            .find(|model| model.id == "fable")
            .expect("fable offered");
        assert!(fable.metered);
        for model in &claude.models {
            if model.id != "fable" {
                assert!(!model.metered, "{} must be plan-included", model.id);
            }
        }
        // Invariant 45: no rate is hand-authored into the catalog. Assert against an
        // explicitly EMPTY rate table (not the live env, which an operator may have
        // configured on the machine running the tests).
        for model in priced(claude.models, &HashMap::new()) {
            assert!(model.pricing.is_none(), "{} must not coin a rate", model.id);
        }
        // And rates attach purely from the supplied table, by exact id.
        let table = parse_model_rates(r#"{"opus": {"input": 5.0, "output": 25.0}}"#);
        let repriced = priced(
            detect_one(AgentBackend::ClaudeLocal, "claude").models,
            &table,
        );
        assert!(repriced.iter().any(|model| {
            model.id == "opus"
                && model
                    .pricing
                    .is_some_and(|rate| rate.input_usd_per_mtok == 5.0)
        }));
    }

    #[test]
    fn parses_model_rates_and_drops_garbage() {
        let table = parse_model_rates(
            r#"{
                "gpt-5-codex": {"input": 1.25, "output": 10.0},
                "opus": {"input": 5.0, "output": 25.0},
                "negative": {"input": -1, "output": 2},
                "half": {"input": 1.0}
            }"#,
        );
        assert_eq!(table.len(), 2);
        let rate = table.get("gpt-5-codex").expect("valid entry kept");
        assert_eq!(rate.input_usd_per_mtok, 1.25);
        assert_eq!(rate.output_usd_per_mtok, 10.0);
        assert!(table.contains_key("opus"));
        assert!(parse_model_rates("not json").is_empty());
        assert!(parse_model_rates("[]").is_empty());
        assert!(parse_model_rates("").is_empty());
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
