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
//! bound to that run's session/run/workspace ([`DispatchGovernor::issue_token`])
//! and injects it into the launched CLI's MCP config; the MCP `dispatch_agent`
//! handler presents that token back ([`DispatchGovernor::authorize`]) so a call is
//! never anonymous and never spoofable by a stream. The token carries **no vendor
//! auth** — it is a local capability handle only (ADR-0098 F). The endpoint is
//! localhost-only and the token reuses the pairing-token posture (opaque, high
//! entropy), so the MCP surface is exactly as trusted as the WS wire (ADR-0098 B).
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
}

impl DispatchDenialReason {
    /// A stable machine code (for a tool error payload / logs).
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownToken => "unknown_token",
            Self::UnknownBackend => "unknown_backend",
            Self::BackendNotAllowed => "backend_not_allowed",
            Self::ChildCapReached => "child_cap_reached",
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
/// backend allowlist, child cap). Shared (behind `Arc`) between the adapter that
/// mints/injects tokens at launch and the MCP handler that authorizes dispatches.
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
            tokens: Mutex::new(HashMap::new()),
            child_counts: Mutex::new(HashMap::new()),
        }
    }

    /// The MCP endpoint URL launched CLIs reach.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The resolved per-session child-run cap.
    pub fn child_cap(&self) -> usize {
        self.child_cap
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

    /// Retire a capability token (e.g. when its run ends). Idempotent.
    pub fn revoke(&self, token: &str) {
        self.tokens
            .lock()
            .expect("dispatch token registry mutex is not poisoned")
            .remove(token);
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
        DispatchCaller {
            session_id: session.to_string(),
            run_id: run.to_string(),
            backend: AgentBackend::ClaudeLocal,
            workspace_root: "/work".to_string(),
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
