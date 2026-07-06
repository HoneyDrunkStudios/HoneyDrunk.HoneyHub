//! Cross-backend subagent dispatch governance (ADR-0098 `dispatch_agent`).
//!
//! An agent inside a running HoneyHub chat can start a **child** bridge run on
//! another backend (a Claude Code chat dispatching Codex grunt work, and the
//! reverse). This module owns the **host-side governance** for that new initiation
//! surface — the same host-owned named-action posture group checks use
//! ([`crate::checks`]): the agent picks a sanctioned backend **id** and a task,
//! never a command line (ADR-0098 A/B), and the host owns what a dispatch resolves
//! to, whether it is allowed, how many children a session may spawn, and audits
//! each one.
//!
//! Trust model. Every dispatch is attributed to the **parent run that made it** via
//! a per-run **capability token**: when a run launches, the adapter mints a token
//! bound to that run's session/run/workspace/depth ([`DispatchGovernor::issue_token`])
//! and injects it into the launched CLI's MCP config; the MCP `dispatch_agent`
//! handler presents that token back ([`DispatchGovernor::authorize`]) so a call is
//! never anonymous and never spoofable by a stream. The token carries **no vendor
//! auth** — it is a local capability handle only (ADR-0098 F). It is opaque, high
//! entropy, localhost-only, and retired on run end ([`DispatchGovernor::revoke_run`]),
//! so it cannot outlive the parent run and the MCP surface is no softer than the WS wire.
//!
//! ADR divergence (flagged for an ADR-0098 amendment, NOT silently taken). ADR-0098 §B and
//! its Decision Ledger pin `[Firm]` "the MCP endpoint reuses the **same PairingRegistry
//! token** the WS server uses — no second credential surface." This implementation instead
//! mints a **per-run** capability token, because the shared pairing token cannot attribute a
//! dispatch to a specific parent run — and that attribution is exactly what the parent linkage
//! (ADR-0098 C), the per-session child cap (D2), the depth cap, and per-run revocation all
//! require. The security properties the `[Firm]` line protects are preserved (localhost-only,
//! opaque/high-entropy, carries no vendor auth, no anonymous port), so this is a *stronger*
//! bound, not a softer one; but "reuse the pairing token / no second surface" is a `[Firm]`
//! line, so reconciling it is an ADR-0098 amendment, not a code change. See the PR report.
//!
//! The transport (a bridge-hosted streamable-HTTP MCP server) lives in the host
//! binary; this module is the backend-agnostic policy core so it stays pure and
//! unit-testable without a network or a live CLI.

use crate::adapter::AgentBackend;
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

/// Default per-session child-run cap (ADR-0098 D2), `[Provisional]`. A ceiling on
/// how many children **one** parent session may spawn, so a looping or runaway
/// parent cannot fan out unbounded runs (token burn / subscription exhaustion). A
/// dispatch that would exceed it is refused with an explicit denial the parent sees
/// as a tool result, never a silent drop. Tunable via `HONEYHUB_DISPATCH_CHILD_CAP`.
pub const DEFAULT_CHILD_CAP: usize = 4;

/// Default max **depth** of the dispatch tree (ADR-0098 D2 hardening), `[Provisional]`. A
/// dispatched child can itself dispatch, so without a ceiling a looping chain could recurse
/// unbounded even while each session stays under its own child cap. A run already at this
/// depth is refused when it tries to dispatch further, so the deepest child sits at this depth
/// (an operator run is depth 0). Small on purpose; tunable via `HONEYHUB_DISPATCH_MAX_DEPTH`.
pub const DEFAULT_MAX_DISPATCH_DEPTH: usize = 3;

/// The reasoning-effort levels a dispatch may request. `effort` becomes a backend config
/// override (Codex `-c model_reasoning_effort=<level>`), so it is validated against this known
/// set rather than passed through unchecked (ADR-0098 A — the host governs what a dispatch
/// resolves to). Compared case-insensitively after trimming.
pub const KNOWN_EFFORT_LEVELS: &[&str] = &["minimal", "low", "medium", "high"];

/// The stable server name the bridge injects into a launched CLI's MCP config for
/// the dispatch endpoint (e.g. Claude Code `--mcp-config`). Also the audit tag.
pub const DISPATCH_SERVER_NAME: &str = "honeyhub-dispatch";

/// WHY a dispatch was refused — typed, so a caller folds on a stable reason instead
/// of matching human-readable text (mirrors [`crate::checks::CheckDenialReason`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchDenialReason {
    /// No capability token was presented, or it does not map to a live parent run.
    /// (A dispatch is never anonymous — the token is how the host attributes it.)
    UnknownToken,
    /// The `backend` id is not one the host knows (not claude/codex/copilot).
    UnknownBackend,
    /// The backend is known but not on the operator's dispatch allowlist. Composes
    /// with, and never widens, the existing bridge backend allowlist (ADR-0098 D1).
    BackendNotAllowed,
    /// The parent session has already spawned its capped number of children
    /// (ADR-0098 D2).
    ChildCapReached,
    /// The dispatch tree is already at its maximum depth: the parent run sits at
    /// [`DispatchGovernor::max_depth`], so nesting a deeper child is refused (ADR-0098 D2
    /// hardening — a dispatched child can itself dispatch, so depth is bounded).
    DepthCapReached,
    /// A `model`/`effort` override was not one the host accepts (an unknown effort level or a
    /// model id that is not model-id-shaped). The host governs these, so a bad override is
    /// refused rather than passed through to the launched CLI (ADR-0098 A).
    InvalidOverride,
}

impl DispatchDenialReason {
    /// A stable machine code (for a tool error payload / logs).
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownToken => "unknown_token",
            Self::UnknownBackend => "unknown_backend",
            Self::BackendNotAllowed => "backend_not_allowed",
            Self::ChildCapReached => "child_cap_reached",
            Self::DepthCapReached => "depth_cap_reached",
            Self::InvalidOverride => "invalid_override",
        }
    }
}

/// A refused dispatch: the typed reason plus a human-readable explanation the parent
/// agent sees as its tool result (ADR-0098 D2 — never a silent drop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchDenial {
    pub reason: DispatchDenialReason,
    pub message: String,
}

impl DispatchDenial {
    fn new(reason: DispatchDenialReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

/// The parent a capability token maps back to: who dispatched, on what backend, and
/// the workspace root a child inherits. Recorded at launch, resolved on dispatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchCaller {
    pub session_id: String,
    pub run_id: String,
    pub backend: AgentBackend,
    pub workspace_root: String,
    /// This run's depth in the dispatch tree: an operator-started run is `0`, a child it
    /// dispatches is `1`, that child's child `2`, and so on. Threaded so the governor can
    /// refuse a dispatch once the tree is already at its [`DispatchGovernor::max_depth`]
    /// (bounding runaway recursion, complementing the per-session child cap; ADR-0098 D2).
    pub depth: usize,
}

/// A successful authorization: the attributed parent plus the **resolved** child
/// backend the host will launch. The caller uses this to build a parented child
/// [`crate::adapter::StartRunRequest`] through the existing runtime start path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchAdmission {
    pub caller: DispatchCaller,
    pub backend: AgentBackend,
}

/// Map a `dispatch_agent` `backend` id to an [`AgentBackend`]. Accepts both the
/// short id (`claude`) and the canonical wire id (`claude.local`), case-insensitive
/// and trimmed, so the model can name a backend the way an operator would. `None`
/// for anything the host does not know — the host owns the backend set, so an
/// unknown id is refused rather than guessed (ADR-0098 A).
pub fn parse_backend(name: &str) -> Option<AgentBackend> {
    match name.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude.local" | "claude-code" | "claudecode" => Some(AgentBackend::ClaudeLocal),
        "codex" | "codex.local" => Some(AgentBackend::CodexLocal),
        "copilot" | "copilot.local" | "github-copilot" => Some(AgentBackend::CopilotLocal),
        _ => None,
    }
}

/// The short, stable id for a backend (for audit lines and tool-result text).
pub fn backend_id(backend: AgentBackend) -> &'static str {
    match backend {
        AgentBackend::ClaudeLocal => "claude",
        AgentBackend::CodexLocal => "codex",
        AgentBackend::CopilotLocal => "copilot",
    }
}

/// Resolve the per-session child-run cap from `HONEYHUB_DISPATCH_CHILD_CAP`, falling
/// back to [`DEFAULT_CHILD_CAP`]. A `0` or unparseable value falls back to the
/// default rather than disabling the ceiling (an unbounded cap is never the quiet
/// result of a typo).
pub fn child_cap_from_env() -> usize {
    std::env::var("HONEYHUB_DISPATCH_CHILD_CAP")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|cap| *cap > 0)
        .unwrap_or(DEFAULT_CHILD_CAP)
}

/// Resolve the max dispatch-tree depth from `HONEYHUB_DISPATCH_MAX_DEPTH`, falling back to
/// [`DEFAULT_MAX_DISPATCH_DEPTH`]. A `0` or unparseable value falls back to the default rather
/// than disabling the ceiling (an unbounded tree is never the quiet result of a typo).
pub fn max_depth_from_env() -> usize {
    std::env::var("HONEYHUB_DISPATCH_MAX_DEPTH")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|depth| *depth > 0)
        .unwrap_or(DEFAULT_MAX_DISPATCH_DEPTH)
}

/// Whether `model` is shaped like a model id the host will accept as a dispatch override: a
/// bounded, non-empty run of ASCII alphanumerics and the id punctuation real model slugs use
/// (`-._:/`). This is a conservative **shape** gate that keeps an agent from smuggling arbitrary
/// content into the launched CLI's `-c model=<...>` override; a full per-backend model-catalog
/// allowlist is a follow-up (ADR-0098 E routing map). Compared on the trimmed value.
pub fn is_valid_model_id(model: &str) -> bool {
    let model = model.trim();
    !model.is_empty()
        && model.len() <= 128
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '/'))
}

/// The operator's dispatch backend allowlist. Defaults to `default_backends` (the
/// backends the operator already configured/allowlisted), optionally **narrowed**
/// (never widened) by `HONEYHUB_DISPATCH_BACKENDS` (a comma-separated list of
/// backend ids). An env entry that is not a subset of the default is ignored, so
/// the dispatch allowlist can only ever be a floor of the existing one
/// (ADR-0098 D1). An empty result means "dispatch to nothing" — every dispatch is
/// then refused, which is the safe closed default.
pub fn dispatch_backends_from_env(default_backends: &[AgentBackend]) -> Vec<AgentBackend> {
    let Ok(raw) = std::env::var("HONEYHUB_DISPATCH_BACKENDS") else {
        return default_backends.to_vec();
    };
    let requested: Vec<AgentBackend> = raw.split(',').filter_map(parse_backend).collect();
    if requested.is_empty() {
        // An env var that named nothing recognizable is treated as "unset" rather
        // than "deny all", so a typo does not silently disable dispatch.
        return default_backends.to_vec();
    }
    // Intersect with the default: the dispatch allowlist can only narrow.
    requested
        .into_iter()
        .filter(|backend| default_backends.contains(backend))
        .collect()
}

/// The host-owned governor for the `dispatch_agent` capability: the capability-token
/// registry, the per-session child-run counters, and the resolved policy (endpoint,
/// backend allowlist, child cap, and max tree depth). Shared (behind `Arc`) between the
/// adapter that mints/injects tokens at launch and the MCP handler that authorizes dispatches.
/// Tokens are minted per run and retired on run end ([`Self::revoke_run`]) so a token cannot
/// outlive the parent run it was minted for.
///
/// Locks are `std::sync::Mutex` and every critical section is short and
/// await-free, so the governor is safe to touch from both the synchronous adapter
/// path and the async MCP handler.
#[derive(Debug)]
pub struct DispatchGovernor {
    /// The MCP endpoint URL injected into launched CLIs (e.g.
    /// `http://127.0.0.1:8765/mcp`). Empty when dispatch is disabled — the adapter
    /// then injects nothing and the run launches without the tool (graceful).
    endpoint: String,
    allowed_backends: Vec<AgentBackend>,
    child_cap: usize,
    max_depth: usize,
    /// token -> the parent run it was minted for.
    tokens: Mutex<HashMap<String, DispatchCaller>>,
    /// parent session id -> children spawned so far (the cap counter).
    child_counts: Mutex<HashMap<String, usize>>,
}

impl DispatchGovernor {
    /// Build a governor. `endpoint` is the MCP URL launched CLIs reach (empty to
    /// disable injection); `allowed_backends` is the operator's dispatch allowlist;
    /// `child_cap` is the per-session ceiling.
    pub fn new(
        endpoint: impl Into<String>,
        allowed_backends: Vec<AgentBackend>,
        child_cap: usize,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            allowed_backends,
            child_cap,
            max_depth: DEFAULT_MAX_DISPATCH_DEPTH,
            tokens: Mutex::new(HashMap::new()),
            child_counts: Mutex::new(HashMap::new()),
        }
    }

    /// Set the max dispatch-tree depth (chainable; defaults to [`DEFAULT_MAX_DISPATCH_DEPTH`]).
    /// A run already at this depth is refused when it tries to dispatch a deeper child.
    pub fn with_max_depth(mut self, max_depth: usize) -> Self {
        self.max_depth = max_depth;
        self
    }

    /// The MCP endpoint URL launched CLIs reach.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The resolved per-session child-run cap.
    pub fn child_cap(&self) -> usize {
        self.child_cap
    }

    /// The resolved max dispatch-tree depth.
    pub fn max_depth(&self) -> usize {
        self.max_depth
    }

    /// Whether dispatch is live: a non-empty endpoint and at least one allowed
    /// backend. When `false`, the adapter injects nothing (graceful degradation) —
    /// a run launches normally, just without the `dispatch_agent` tool.
    pub fn is_enabled(&self) -> bool {
        !self.endpoint.is_empty() && !self.allowed_backends.is_empty()
    }

    /// Whether a backend is on the dispatch allowlist (display/whitelist helper).
    pub fn allows_backend(&self, backend: AgentBackend) -> bool {
        self.allowed_backends.contains(&backend)
    }

    /// Mint a fresh capability token bound to `caller` and register it. The token is
    /// opaque and high-entropy (the pairing-token shape: two concatenated UUIDs), so
    /// it is unguessable and carries no meaning of its own. Returned once to the
    /// adapter, which injects it into the launched CLI's MCP config.
    pub fn issue_token(&self, caller: DispatchCaller) -> String {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .insert(token.clone(), caller);
        token
    }

    /// Resolve a capability token back to the parent run it was minted for.
    pub fn resolve(&self, token: &str) -> Option<DispatchCaller> {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .get(token)
            .cloned()
    }

    /// The dispatch-tree depth recorded for `run_id`, if it minted a capability token. Used at
    /// child launch to derive the child's depth from its parent's (the child sits one below).
    /// `None` when the run holds no live token (e.g. an operator run on a backend that mints
    /// none, or a run whose token was already revoked).
    pub fn depth_of_run(&self, run_id: &str) -> Option<usize> {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .values()
            .find(|caller| caller.run_id == run_id)
            .map(|caller| caller.depth)
    }

    /// Retire a capability token (e.g. when its run ends). Idempotent.
    pub fn revoke(&self, token: &str) {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .remove(token);
    }

    /// Retire every capability token minted for `run_id` — the run-end lifecycle hook, so a
    /// token cannot outlive the parent run it was minted for (ADR-0098 B trust model). Idempotent.
    pub fn revoke_run(&self, run_id: &str) {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .retain(|_, caller| caller.run_id != run_id);
    }

    /// Retire every capability token minted for any run in `session_id` — the session-end hook.
    /// Idempotent; complements [`Self::revoke_run`] when a whole session is torn down.
    pub fn revoke_session(&self, session_id: &str) {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .retain(|_, caller| caller.session_id != session_id);
    }

    /// Validate the optional `model` / `effort` overrides a `dispatch_agent` call carried. The
    /// host governs these (ADR-0098 A): `effort` must be a known reasoning level and `model`
    /// must be model-id-shaped, so an agent cannot pass arbitrary content through to the
    /// launched CLI's config overrides. `Ok(())` when both are absent or accepted.
    pub fn validate_overrides(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), DispatchDenial> {
        if let Some(model) = model {
            if !is_valid_model_id(model) {
                return Err(DispatchDenial::new(
                    DispatchDenialReason::InvalidOverride,
                    format!("model override `{model}` is not an accepted model id"),
                ));
            }
        }
        if let Some(effort) = effort {
            let normalized = effort.trim().to_ascii_lowercase();
            if !KNOWN_EFFORT_LEVELS.contains(&normalized.as_str()) {
                return Err(DispatchDenial::new(
                    DispatchDenialReason::InvalidOverride,
                    format!(
                        "effort override `{effort}` is not one of: {}",
                        KNOWN_EFFORT_LEVELS.join(", ")
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Authorize a `dispatch_agent(backend, ...)` call presenting `token`:
    ///
    /// 1. resolve the token to its parent run (else [`DispatchDenialReason::UnknownToken`]);
    /// 2. resolve `backend` to a known backend (else [`DispatchDenialReason::UnknownBackend`]);
    /// 3. check the dispatch allowlist (else [`DispatchDenialReason::BackendNotAllowed`]);
    /// 4. atomically check **and reserve** a child slot against the per-session cap
    ///    (else [`DispatchDenialReason::ChildCapReached`]).
    ///
    /// On success the slot is reserved and the caller must either start the child
    /// (the slot stays consumed) or call [`Self::release`] if the start fails, so a
    /// failed launch does not permanently burn a slot.
    pub fn authorize(
        &self,
        token: &str,
        backend: &str,
    ) -> Result<DispatchAdmission, DispatchDenial> {
        let caller = self.resolve(token).ok_or_else(|| {
            DispatchDenial::new(
                DispatchDenialReason::UnknownToken,
                "dispatch requires a valid per-run capability token; none was presented",
            )
        })?;

        let backend = parse_backend(backend).ok_or_else(|| {
            DispatchDenial::new(
                DispatchDenialReason::UnknownBackend,
                format!(
                    "`{}` is not a known backend; allowed: {}",
                    backend.trim(),
                    self.allowed_backend_ids().join(", ")
                ),
            )
        })?;

        if !self.allowed_backends.contains(&backend) {
            return Err(DispatchDenial::new(
                DispatchDenialReason::BackendNotAllowed,
                format!(
                    "backend `{}` is not on the dispatch allowlist; allowed: {}",
                    backend_id(backend),
                    self.allowed_backend_ids().join(", ")
                ),
            ));
        }

        // Bound the tree depth: a child can itself dispatch, so a parent already at the max
        // depth may not nest a deeper one (complements the per-session child cap; ADR-0098 D2).
        if caller.depth >= self.max_depth {
            return Err(DispatchDenial::new(
                DispatchDenialReason::DepthCapReached,
                format!(
                    "dispatch tree is at its max depth ({}); refuse to nest a deeper child",
                    self.max_depth
                ),
            ));
        }

        // Atomically check + reserve a child slot for this parent session.
        {
            let mut counts = self
                .child_counts
                .lock()
                .expect("dispatch child-count mutex is not poisoned");
            let count = counts.entry(caller.session_id.clone()).or_insert(0);
            if *count >= self.child_cap {
                return Err(DispatchDenial::new(
                    DispatchDenialReason::ChildCapReached,
                    format!(
                        "session {} has reached its child-run cap ({}); refuse to fan out further",
                        caller.session_id, self.child_cap
                    ),
                ));
            }
            *count += 1;
        }

        Ok(DispatchAdmission { caller, backend })
    }

    /// Give back a reserved child slot for `session_id` (the child start failed after
    /// [`Self::authorize`] reserved it). Saturating at zero, so a stray release never
    /// underflows the counter.
    pub fn release(&self, session_id: &str) {
        let mut counts = self
            .child_counts
            .lock()
            .expect("dispatch child-count mutex is not poisoned");
        if let Some(count) = counts.get_mut(session_id) {
            *count = count.saturating_sub(1);
        }
    }

    /// How many children a parent session has spawned so far (test/telemetry).
    pub fn children_of(&self, session_id: &str) -> usize {
        self.child_counts
            .lock()
            .expect("dispatch child-count mutex is not poisoned")
            .get(session_id)
            .copied()
            .unwrap_or(0)
    }

    fn allowed_backend_ids(&self) -> Vec<&'static str> {
        self.allowed_backends
            .iter()
            .map(|backend| backend_id(*backend))
            .collect()
    }
}

/// Emit a host audit line for a dispatch, exactly as the check runner audits its
/// spawns ([`crate::checks`]): who dispatched, from what backend/run, to what
/// backend, and a trimmed task summary — never the full task text. So the operator
/// can trace every agent-initiated run from the bridge console (ADR-0098 A/G).
pub fn audit_dispatch(caller: &DispatchCaller, backend: AgentBackend, task: &str) {
    eprintln!(
        "[dispatch] {} run {} (session {}) -> {} child: \"{}\"",
        backend_id(caller.backend),
        caller.run_id,
        caller.session_id,
        backend_id(backend),
        summarize_task(task),
    );
}

/// A short, single-line task summary for audit/tool-result text: trimmed, newline-
/// collapsed, and clamped so a long prompt never floods a log line.
pub fn summarize_task(task: &str) -> String {
    let collapsed: String = task.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 80 {
        format!("{}…", collapsed.chars().take(80).collect::<String>())
    } else {
        collapsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(session: &str, run: &str) -> DispatchCaller {
        caller_at_depth(session, run, 0)
    }

    fn caller_at_depth(session: &str, run: &str, depth: usize) -> DispatchCaller {
        DispatchCaller {
            session_id: session.to_string(),
            run_id: run.to_string(),
            backend: AgentBackend::ClaudeLocal,
            workspace_root: "/work".to_string(),
            depth,
        }
    }

    fn governor(backends: Vec<AgentBackend>, cap: usize) -> DispatchGovernor {
        DispatchGovernor::new("http://127.0.0.1:8765/mcp", backends, cap)
    }

    #[test]
    fn parse_backend_maps_short_and_canonical_ids_and_rejects_garbage() {
        assert_eq!(parse_backend("claude"), Some(AgentBackend::ClaudeLocal));
        assert_eq!(
            parse_backend("Claude.Local"),
            Some(AgentBackend::ClaudeLocal)
        );
        assert_eq!(parse_backend(" codex "), Some(AgentBackend::CodexLocal));
        assert_eq!(
            parse_backend("copilot.local"),
            Some(AgentBackend::CopilotLocal)
        );
        assert_eq!(parse_backend("rm -rf /"), None);
        assert_eq!(parse_backend(""), None);
    }

    #[test]
    fn issue_and_resolve_round_trips_and_tokens_are_distinct() {
        let gov = governor(vec![AgentBackend::ClaudeLocal], DEFAULT_CHILD_CAP);
        let first = gov.issue_token(caller("s1", "r1"));
        let second = gov.issue_token(caller("s1", "r2"));
        assert_ne!(first, second);
        assert_eq!(gov.resolve(&first).expect("first resolves").run_id, "r1");
        assert_eq!(gov.resolve(&second).expect("second resolves").run_id, "r2");
        assert!(gov.resolve("not-a-token").is_none());
        gov.revoke(&first);
        assert!(gov.resolve(&first).is_none());
    }

    #[test]
    fn authorize_rejects_an_unknown_token() {
        let gov = governor(vec![AgentBackend::ClaudeLocal], DEFAULT_CHILD_CAP);
        let denial = gov
            .authorize("no-such-token", "codex")
            .expect_err("unknown token is refused");
        assert_eq!(denial.reason, DispatchDenialReason::UnknownToken);
    }

    #[test]
    fn authorize_rejects_an_unknown_backend_id() {
        let gov = governor(vec![AgentBackend::CodexLocal], DEFAULT_CHILD_CAP);
        let token = gov.issue_token(caller("s1", "r1"));
        let denial = gov
            .authorize(&token, "not-a-backend")
            .expect_err("unknown backend is refused");
        assert_eq!(denial.reason, DispatchDenialReason::UnknownBackend);
    }

    #[test]
    fn authorize_rejects_a_disallowed_backend() {
        // Claude is the parent; only Codex is on the dispatch allowlist, so a
        // dispatch to Copilot (a real backend, but not allowed) is refused.
        let gov = governor(vec![AgentBackend::CodexLocal], DEFAULT_CHILD_CAP);
        let token = gov.issue_token(caller("s1", "r1"));
        let denial = gov
            .authorize(&token, "copilot")
            .expect_err("disallowed backend is refused");
        assert_eq!(denial.reason, DispatchDenialReason::BackendNotAllowed);
        // The allowed backend still authorizes.
        let admission = gov.authorize(&token, "codex").expect("codex is allowed");
        assert_eq!(admission.backend, AgentBackend::CodexLocal);
        assert_eq!(admission.caller.run_id, "r1");
    }

    #[test]
    fn authorize_enforces_the_per_session_child_cap() {
        let gov = governor(vec![AgentBackend::CodexLocal], 2);
        let token = gov.issue_token(caller("s1", "r1"));

        gov.authorize(&token, "codex").expect("first child");
        gov.authorize(&token, "codex").expect("second child");
        assert_eq!(gov.children_of("s1"), 2);

        let denial = gov
            .authorize(&token, "codex")
            .expect_err("third child exceeds the cap");
        assert_eq!(denial.reason, DispatchDenialReason::ChildCapReached);

        // A different parent session has its own independent budget.
        let other = gov.issue_token(caller("s2", "r9"));
        gov.authorize(&other, "codex")
            .expect("a different session is not capped by s1's children");
        assert_eq!(gov.children_of("s2"), 1);

        // Releasing a reserved slot (a failed child start) frees room again.
        gov.release("s1");
        assert_eq!(gov.children_of("s1"), 1);
        gov.authorize(&token, "codex")
            .expect("a freed slot admits another child");
        assert_eq!(gov.children_of("s1"), 2);
    }

    #[test]
    fn authorize_enforces_the_dispatch_tree_depth_cap() {
        // max_depth 2: a run at depth 0 or 1 may dispatch, a run already at depth 2 may not.
        let gov = governor(vec![AgentBackend::CodexLocal], DEFAULT_CHILD_CAP).with_max_depth(2);

        let root = gov.issue_token(caller_at_depth("s1", "r0", 0));
        gov.authorize(&root, "codex")
            .expect("a root run may dispatch");

        let mid = gov.issue_token(caller_at_depth("s2", "r1", 1));
        gov.authorize(&mid, "codex")
            .expect("a depth-1 run may dispatch");

        let deep = gov.issue_token(caller_at_depth("s3", "r2", 2));
        let denial = gov
            .authorize(&deep, "codex")
            .expect_err("a run at the max depth may not dispatch further");
        assert_eq!(denial.reason, DispatchDenialReason::DepthCapReached);
    }

    #[test]
    fn depth_of_run_reports_a_tokens_recorded_depth() {
        let gov = governor(vec![AgentBackend::ClaudeLocal], DEFAULT_CHILD_CAP);
        gov.issue_token(caller_at_depth("s1", "r-mid", 2));
        assert_eq!(gov.depth_of_run("r-mid"), Some(2));
        assert_eq!(gov.depth_of_run("no-such-run"), None);
    }

    #[test]
    fn revoke_run_and_session_retire_the_right_tokens() {
        let gov = governor(vec![AgentBackend::ClaudeLocal], DEFAULT_CHILD_CAP);
        let a = gov.issue_token(caller("s1", "r1"));
        let b = gov.issue_token(caller("s1", "r2"));
        let c = gov.issue_token(caller("s2", "r3"));

        // revoke_run retires only the matching run's token; siblings in the session survive.
        gov.revoke_run("r1");
        assert!(gov.resolve(&a).is_none());
        assert!(gov.resolve(&b).is_some());
        assert!(gov.resolve(&c).is_some());

        // revoke_session retires every token in the session at once.
        gov.revoke_session("s1");
        assert!(gov.resolve(&b).is_none());
        assert!(
            gov.resolve(&c).is_some(),
            "a different session is untouched"
        );
    }

    #[test]
    fn validate_overrides_accepts_known_and_refuses_bad_model_or_effort() {
        let gov = governor(vec![AgentBackend::ClaudeLocal], DEFAULT_CHILD_CAP);

        // Absent overrides, a known effort, and a model-id-shaped string all pass.
        assert!(gov.validate_overrides(None, None).is_ok());
        assert!(gov
            .validate_overrides(Some("gpt-5-codex"), Some("High"))
            .is_ok());
        assert!(gov
            .validate_overrides(Some("claude-opus-4-8"), Some("medium"))
            .is_ok());

        // An unknown effort level is refused.
        let effort = gov
            .validate_overrides(None, Some("turbo"))
            .expect_err("an unknown effort is refused");
        assert_eq!(effort.reason, DispatchDenialReason::InvalidOverride);

        // A model with whitespace / shell-ish content is not model-id-shaped — refused.
        let model = gov
            .validate_overrides(Some("gpt-5 --dangerous"), None)
            .expect_err("a non-model-id-shaped override is refused");
        assert_eq!(model.reason, DispatchDenialReason::InvalidOverride);
        assert!(gov.validate_overrides(Some(""), None).is_err());
    }

    #[test]
    fn max_depth_env_overrides_default_and_ignores_garbage() {
        std::env::remove_var("HONEYHUB_DISPATCH_MAX_DEPTH");
        assert_eq!(max_depth_from_env(), DEFAULT_MAX_DISPATCH_DEPTH);
        std::env::set_var("HONEYHUB_DISPATCH_MAX_DEPTH", "5");
        assert_eq!(max_depth_from_env(), 5);
        // A zero or unparseable value falls back to the default (never an unbounded tree).
        std::env::set_var("HONEYHUB_DISPATCH_MAX_DEPTH", "0");
        assert_eq!(max_depth_from_env(), DEFAULT_MAX_DISPATCH_DEPTH);
        std::env::set_var("HONEYHUB_DISPATCH_MAX_DEPTH", "nope");
        assert_eq!(max_depth_from_env(), DEFAULT_MAX_DISPATCH_DEPTH);
        std::env::remove_var("HONEYHUB_DISPATCH_MAX_DEPTH");
    }

    #[test]
    fn is_valid_model_id_shape_gate() {
        assert!(is_valid_model_id("opus"));
        assert!(is_valid_model_id("gpt-5-codex"));
        assert!(is_valid_model_id("us.anthropic.claude-opus-4-8:0"));
        assert!(is_valid_model_id("provider/model_v1"));
        assert!(!is_valid_model_id(""));
        assert!(!is_valid_model_id("has space"));
        assert!(!is_valid_model_id("semi;colon"));
        assert!(!is_valid_model_id(&"x".repeat(200)));
    }

    #[test]
    fn disabled_when_endpoint_empty_or_no_backends() {
        assert!(!DispatchGovernor::new("", vec![AgentBackend::CodexLocal], 4).is_enabled());
        assert!(!DispatchGovernor::new("http://x/mcp", vec![], 4).is_enabled());
        assert!(
            DispatchGovernor::new("http://x/mcp", vec![AgentBackend::CodexLocal], 4).is_enabled()
        );
    }

    #[test]
    fn dispatch_backends_env_can_only_narrow_the_default() {
        // Cleared env -> defaults through unchanged.
        std::env::remove_var("HONEYHUB_DISPATCH_BACKENDS");
        let default = vec![AgentBackend::ClaudeLocal, AgentBackend::CodexLocal];
        assert_eq!(dispatch_backends_from_env(&default), default);

        // An env subset narrows; an entry outside the default is dropped (never widens).
        std::env::set_var("HONEYHUB_DISPATCH_BACKENDS", "codex,copilot");
        assert_eq!(
            dispatch_backends_from_env(&default),
            vec![AgentBackend::CodexLocal]
        );
        std::env::remove_var("HONEYHUB_DISPATCH_BACKENDS");
    }

    #[test]
    fn summarize_task_collapses_and_clamps() {
        assert_eq!(
            summarize_task("  hello   world \n next "),
            "hello world next"
        );
        let long = "word ".repeat(40);
        let summary = summarize_task(&long);
        assert!(summary.chars().count() <= 81); // 80 + the ellipsis
        assert!(summary.ends_with('…'));
    }
}
