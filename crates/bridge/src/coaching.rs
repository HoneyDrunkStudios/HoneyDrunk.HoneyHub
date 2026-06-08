//! Rules-based session coaching (ADR-0092 D4 / packet 09 §3e).
//!
//! Deterministic rules over a session's run/usage state that emit advisory
//! [`PolicyHint`]s — the structured, wire-borne, persistable counterpart to the
//! UI's inline per-session diagnostics. There is **no learned model** here: every
//! hint is a pure function of the snapshot (PDR-0011 Amendment §2 keeps the learned
//! per-user coach a separately gated v2 decision).
//!
//! Per ADR-0092 D2/D4 the local-v1 posture is **advisory only** — coaching never
//! emits a `Block` severity (two of three backends report `derived`/`estimated`
//! usage, so a hard local action on an estimate would fire wrongly). Hints are
//! `Info` or `Warning`.
//!
//! Scope note (packet 09 §3e): the routing-dependent rules — `routing_hint`,
//! `mode_fit`, `subscription_optimization` — are deferred to land **with** the
//! routing engine (§3d), whose app-tier policy boundary is still an open
//! `[Provisional]` seam. The rules implemented here need only session/usage data
//! and no routing context.

use crate::adapter::AgentBackend;
use crate::session::{PolicyHint, PolicyHintSeverity, UsageFidelity, UsageSignal};

/// A session's context is "large" past any of these (tunable). Mirrors the UI
/// diagnostics thresholds; crossing one yields a `stale_session` hint.
pub const STALE_SESSION_TOKENS: u64 = 120_000;
pub const STALE_SESSION_MESSAGES: usize = 24;
pub const STALE_SESSION_MINUTES: f64 = 30.0;

/// Session spend (exact/derived only) at or above this yields a `high_cost_session`
/// hint. Estimated-only spend never triggers it — a guess must not drive a warning.
pub const HIGH_COST_USD: f64 = 5.0;

/// The state one coaching pass reasons over. Timestamps/data are passed in so the
/// crate stays clock-free and the rules stay deterministic and testable.
pub struct CoachingSnapshot<'a> {
    pub session_id: &'a str,
    /// The current run, if any. Stamped onto each hint. Note the local store only
    /// persists a hint that carries a `run_id` (`put_policy_hint` rejects a hint with
    /// none); a session-level hint with no run is still valid to surface in the UI but
    /// is not persisted by that path until a run is attached.
    pub run_id: Option<&'a str>,
    pub backend: AgentBackend,
    pub message_count: usize,
    pub elapsed_minutes: Option<f64>,
    pub usage: &'a [UsageSignal],
    /// RFC3339 timestamp for the minted hints (caller-supplied; see module note).
    pub now: &'a str,
}

fn signal_tokens(signal: &UsageSignal) -> u64 {
    signal
        .total_tokens
        .unwrap_or_else(|| signal.input_tokens.unwrap_or(0) + signal.output_tokens.unwrap_or(0))
}

impl CoachingSnapshot<'_> {
    fn session_tokens(&self) -> u64 {
        self.usage.iter().map(signal_tokens).sum()
    }

    /// Sum of USD across signals whose cost is exact or derived (deterministic) —
    /// estimated signals are excluded so a guessed dollar value never drives a hint.
    fn grounded_usd(&self) -> f64 {
        self.usage
            .iter()
            .filter(|signal| {
                matches!(
                    signal.fidelity,
                    UsageFidelity::Exact | UsageFidelity::Derived
                )
            })
            .filter_map(|signal| signal.total_usd)
            .sum()
    }

    fn has_usage(&self) -> bool {
        !self.usage.is_empty()
    }

    fn all_estimated(&self) -> bool {
        self.has_usage()
            && self
                .usage
                .iter()
                .all(|signal| signal.fidelity == UsageFidelity::Estimated)
    }
}

fn hint(
    snapshot: &CoachingSnapshot,
    code: &str,
    severity: PolicyHintSeverity,
    message: String,
) -> PolicyHint {
    PolicyHint {
        // Deterministic id: one active hint per (session, code). Recomputing the same
        // snapshot yields the same id, so re-emitting a hint updates rather than
        // duplicates it (idempotent persistence/replay). Keeps `coach` fully pure — no
        // randomness or clock — as the module contract claims.
        id: format!("coach:{}:{}", snapshot.session_id, code),
        session_id: snapshot.session_id.to_string(),
        run_id: snapshot.run_id.map(str::to_string),
        code: code.to_string(),
        severity,
        message,
        created_at: snapshot.now.to_string(),
    }
}

/// Evaluate the rules against a snapshot, returning every triggered advisory hint
/// (possibly empty). Order is stable: stale-session, high-cost, estimate-only.
pub fn coach(snapshot: &CoachingSnapshot) -> Vec<PolicyHint> {
    let mut hints = Vec::new();

    // 1. Stale session — large context: prefer a fresh session.
    let tokens = snapshot.session_tokens();
    let over_tokens = tokens >= STALE_SESSION_TOKENS;
    let over_messages = snapshot.message_count >= STALE_SESSION_MESSAGES;
    let over_minutes = snapshot
        .elapsed_minutes
        .is_some_and(|minutes| minutes >= STALE_SESSION_MINUTES);
    if over_tokens || over_messages || over_minutes {
        let reason = if over_tokens {
            format!("has used {tokens} tokens of context")
        } else if over_messages {
            format!("has run {} messages", snapshot.message_count)
        } else {
            let minutes = snapshot.elapsed_minutes.unwrap_or_default().round() as i64;
            format!("has run ~{minutes} min")
        };
        hints.push(hint(
            snapshot,
            "stale_session",
            PolicyHintSeverity::Warning,
            format!(
                "This session {reason}. Starting a fresh session keeps the agent \
                 focused and can respond faster and cost less."
            ),
        ));
    }

    // 2. High-cost session — grounded (exact/derived) spend over the threshold.
    let grounded = snapshot.grounded_usd();
    if grounded >= HIGH_COST_USD {
        hints.push(hint(
            snapshot,
            "high_cost_session",
            PolicyHintSeverity::Warning,
            format!(
                "This session has spent about ${grounded:.2}. Consider whether the \
                 remaining work needs the same model, or split it across sessions."
            ),
        ));
    }

    // 3. Estimate-only spend — the figures shown are approximate; say so plainly so
    //    they are never read as exact (ADR-0092 D2 honesty rule).
    if snapshot.all_estimated() {
        hints.push(hint(
            snapshot,
            "estimate_only_spend",
            PolicyHintSeverity::Info,
            // Backend-agnostic: `all_estimated()` only tells us the fidelity is
            // estimated, not which proxy produced it, so the wording does not claim a
            // specific unit (e.g. premium requests).
            "Usage for this session is estimated, so the spend figures shown are \
             approximate rather than exact."
                .to_string(),
        ));
    }

    hints
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::UsageConfidence;

    fn usage(fidelity: UsageFidelity, tokens: u64, usd: Option<f64>) -> UsageSignal {
        UsageSignal {
            id: "u".to_string(),
            session_id: "s1".to_string(),
            run_id: "r1".to_string(),
            backend: AgentBackend::ClaudeLocal,
            fidelity,
            model_label: Some("m".to_string()),
            input_tokens: Some(tokens),
            output_tokens: Some(0),
            total_tokens: Some(tokens),
            total_usd: usd,
            premium_requests: None,
            duration_ms: None,
            confidence: Some(UsageConfidence::High),
            recorded_at: "2026-06-08T12:00:00Z".to_string(),
        }
    }

    fn snapshot<'a>(
        message_count: usize,
        elapsed_minutes: Option<f64>,
        usage: &'a [UsageSignal],
    ) -> CoachingSnapshot<'a> {
        CoachingSnapshot {
            session_id: "s1",
            run_id: Some("r1"),
            backend: AgentBackend::ClaudeLocal,
            message_count,
            elapsed_minutes,
            usage,
            now: "2026-06-08T12:00:00Z",
        }
    }

    fn codes(hints: &[PolicyHint]) -> Vec<&str> {
        hints.iter().map(|hint| hint.code.as_str()).collect()
    }

    #[test]
    fn quiet_session_yields_no_hints() {
        let usage = [usage(UsageFidelity::Exact, 1_000, Some(0.02))];
        let hints = coach(&snapshot(3, Some(5.0), &usage));
        assert!(hints.is_empty());
    }

    #[test]
    fn large_token_context_warns_to_start_fresh() {
        let usage = [usage(
            UsageFidelity::Exact,
            STALE_SESSION_TOKENS + 1,
            Some(0.5),
        )];
        let hints = coach(&snapshot(2, Some(1.0), &usage));
        assert_eq!(codes(&hints), ["stale_session"]);
        assert_eq!(hints[0].severity, PolicyHintSeverity::Warning);
        assert_eq!(hints[0].run_id.as_deref(), Some("r1"));
    }

    #[test]
    fn long_running_or_chatty_session_is_stale() {
        let usage = [usage(UsageFidelity::Exact, 100, Some(0.01))];
        assert_eq!(
            codes(&coach(&snapshot(STALE_SESSION_MESSAGES, None, &usage))),
            ["stale_session"]
        );
        assert_eq!(
            codes(&coach(&snapshot(2, Some(STALE_SESSION_MINUTES), &usage))),
            ["stale_session"]
        );
    }

    #[test]
    fn high_grounded_spend_warns() {
        let usage = [usage(
            UsageFidelity::Derived,
            1_000,
            Some(HIGH_COST_USD + 1.0),
        )];
        let hints = coach(&snapshot(2, Some(1.0), &usage));
        assert!(codes(&hints).contains(&"high_cost_session"));
    }

    #[test]
    fn estimated_spend_never_triggers_cost_warning_but_notes_it_is_approximate() {
        // A big estimated USD must NOT trigger high_cost (a guess can't drive a warning).
        let usage = [usage(
            UsageFidelity::Estimated,
            1_000,
            Some(HIGH_COST_USD + 50.0),
        )];
        let hints = coach(&snapshot(2, Some(1.0), &usage));
        assert!(!codes(&hints).contains(&"high_cost_session"));
        assert_eq!(codes(&hints), ["estimate_only_spend"]);
        assert_eq!(hints[0].severity, PolicyHintSeverity::Info);
    }

    #[test]
    fn hints_are_deterministic_across_calls() {
        // Same snapshot in → identical hints out (ids included), so re-running is
        // idempotent for persistence/replay. One active hint per (session, code).
        let usage = [usage(
            UsageFidelity::Exact,
            STALE_SESSION_TOKENS + 1,
            Some(0.5),
        )];
        let first = coach(&snapshot(2, Some(1.0), &usage));
        let second = coach(&snapshot(2, Some(1.0), &usage));
        assert_eq!(first, second);
        assert_eq!(first[0].id, "coach:s1:stale_session");
    }

    #[test]
    fn never_emits_a_block_severity() {
        // Trip every rule at once; advisory-only posture means no Block (ADR-0092 D4).
        let usage = [usage(
            UsageFidelity::Estimated,
            STALE_SESSION_TOKENS + 1,
            Some(999.0),
        )];
        let hints = coach(&snapshot(
            STALE_SESSION_MESSAGES,
            Some(STALE_SESSION_MINUTES),
            &usage,
        ));
        assert!(!hints.is_empty());
        assert!(hints
            .iter()
            .all(|hint| hint.severity != PolicyHintSeverity::Block));
    }
}
