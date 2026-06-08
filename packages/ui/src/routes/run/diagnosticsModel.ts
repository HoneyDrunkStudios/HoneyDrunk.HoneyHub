import type {
  AgentBackend,
  DispatchMessage,
  UsageFidelity,
  UsageSignal
} from "@honeydrunk/honeyhub-types";

// Per-session diagnostics shown inline in the run screen: where the session was
// routed, its token/cost usage (whole session + last turn), how many messages
// were exchanged, and rules-based session-health recommendations (e.g. when to
// start a fresh session). This is the per-session view; cross-session coaching is
// a separate, later surface (Phase 3 / ADR-0092).

export interface SessionHealth {
  level: "good" | "watch";
  recommendations: string[];
}

export interface SessionDiagnostics {
  provider: AgentBackend;
  model: string;
  fidelity: UsageFidelity | undefined;
  sessionTokens: number;
  sessionUsd: number | undefined;
  lastTurnTokens: number | undefined;
  lastTurnUsd: number | undefined;
  messageCount: number;
  elapsedMs: number | undefined;
  health: SessionHealth;
}

export interface SessionDiagnosticsInput {
  backend: AgentBackend;
  messages: DispatchMessage[];
  usage: UsageSignal[];
}

// Heuristic thresholds (tunable). Crossing any flags a "watch" health with a
// recommendation to consider a fresh session.
export const LONG_SESSION_TOKENS = 120_000;
export const LONG_SESSION_MESSAGES = 24;
export const LONG_SESSION_MINUTES = 30;

function signalTokens(signal: UsageSignal): number | undefined {
  if (signal.totalTokens !== undefined) {
    return signal.totalTokens;
  }
  if (signal.inputTokens !== undefined || signal.outputTokens !== undefined) {
    return (signal.inputTokens ?? 0) + (signal.outputTokens ?? 0);
  }
  return undefined;
}

function elapsedMs(messages: DispatchMessage[]): number | undefined {
  // Use the min/max timestamp across all messages, not first/last: user messages
  // are timestamped client-side and agent messages by the bridge, so order and
  // clock skew can make positional first/last wrong.
  const times = messages
    .map((message) => Date.parse(message.createdAt))
    .filter((time) => !Number.isNaN(time));
  if (times.length < 2) {
    return undefined;
  }
  return Math.max(...times) - Math.min(...times);
}

export function computeSessionDiagnostics(
  input: SessionDiagnosticsInput
): SessionDiagnostics {
  const { backend, messages, usage } = input;
  const latest = usage[usage.length - 1];

  const sessionTokens = usage.reduce((sum, signal) => sum + (signalTokens(signal) ?? 0), 0);
  const usdSignals = usage.filter((signal) => signal.totalUsd !== undefined);
  const sessionUsd =
    usdSignals.length > 0
      ? usdSignals.reduce((sum, signal) => sum + (signal.totalUsd ?? 0), 0)
      : undefined;

  const span = elapsedMs(messages);
  const minutes = span !== undefined ? span / 60_000 : undefined;

  const recommendations: string[] = [];
  if (sessionTokens >= LONG_SESSION_TOKENS) {
    recommendations.push(
      `This session has used ${sessionTokens.toLocaleString()} tokens — its context is large. Starting a fresh session can respond faster and cost less.`
    );
  }
  if (messages.length >= LONG_SESSION_MESSAGES) {
    recommendations.push(
      `${messages.length} messages so far — splitting the remaining work into a new session keeps the agent focused.`
    );
  }
  if (minutes !== undefined && minutes >= LONG_SESSION_MINUTES) {
    recommendations.push(
      `This session has run ~${Math.round(minutes)} min — a fresh session avoids carrying stale context.`
    );
  }

  return {
    // Prefer the backend the usage signal actually reports (the routed backend);
    // fall back to the session's configured backend before any usage arrives.
    provider: latest?.backend ?? backend,
    model: latest?.modelLabel ?? "pending",
    fidelity: latest?.fidelity,
    sessionTokens,
    sessionUsd,
    lastTurnTokens: latest === undefined ? undefined : signalTokens(latest),
    lastTurnUsd: latest?.totalUsd,
    messageCount: messages.length,
    elapsedMs: span,
    health: {
      level: recommendations.length > 0 ? "watch" : "good",
      recommendations
    }
  };
}
