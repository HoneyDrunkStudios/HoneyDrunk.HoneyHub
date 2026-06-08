export type AgentBackend = "claude.local" | "codex.local" | "copilot.local";

export type DispatchRunState =
  | "created"
  | "queued"
  | "starting"
  | "running"
  | "needs_input"
  | "finalizing"
  | "completed"
  | "stopping"
  | "failed"
  | "cancelled";

export type UsageFidelity = "exact" | "derived" | "estimated";

export interface CapabilityFlags {
  streaming_output: boolean;
  interactive_reply: boolean;
  resume_session: boolean;
  stop_signal: boolean;
  structured_events: boolean;
  /** Backend reports an exact cost (tokens + USD), taken directly. */
  usage_exact: boolean;
  /**
   * Backend reports exact token counts but no USD, so the dollar value is derived
   * from the operator-configurable rate table (ADR-0092 D2). At most one of the
   * three usage flags is set; the signal's own `fidelity` tag remains the
   * load-bearing honesty mechanism, these flags are the coarse handshake hint.
   */
  usage_derived: boolean;
  /** Backend exposes neither exact USD nor exact tokens, so figures are estimated. */
  usage_estimated: boolean;
}

export interface DispatchSession {
  id: string;
  backend: AgentBackend;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  currentRunId?: string;
}

export interface DispatchRun {
  id: string;
  sessionId: string;
  state: DispatchRunState;
  task: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export type DispatchMessageRole = "user" | "agent" | "system";

export interface DispatchMessage {
  id: string;
  sessionId: string;
  runId: string;
  role: DispatchMessageRole;
  body: string;
  createdAt: string;
  isPartial?: boolean;
}

export type DispatchControlEventKind =
  | "state_changed"
  | "launch"
  | "reply"
  | "follow_up"
  | "stop"
  | "resume"
  | "process_exit"
  | "approve"
  | "reject"
  | "timeout";

export interface DispatchControlEvent {
  id: string;
  sessionId: string;
  runId: string;
  kind: DispatchControlEventKind;
  createdAt: string;
  summary: string;
}

export type DispatchArtifactKind =
  | "branch"
  | "commit"
  | "pull_request"
  | "issue_packet"
  | "adr_draft"
  | "pdr_draft"
  | "report"
  | "log_bundle";

export interface DispatchArtifact {
  id: string;
  sessionId: string;
  runId: string;
  kind: DispatchArtifactKind;
  label: string;
  href?: string;
  repoRelativePath?: string;
  createdAt: string;
}

export interface UsageSignal {
  id: string;
  sessionId: string;
  runId: string;
  backend: AgentBackend;
  fidelity: UsageFidelity;
  modelLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalUsd?: number;
  premiumRequests?: number;
  durationMs?: number;
  confidence?: "low" | "medium" | "high";
  recordedAt: string;
}

/**
 * A per-(backend, fidelity) rollup of usage across many turns. Backends with
 * different fidelity (exact / derived / estimated) stay in separate rollups so the
 * spend view never sums a measured cost together with an estimate (ADR-0092 D2).
 */
export interface UsageRollup {
  backend: AgentBackend;
  fidelity: UsageFidelity;
  /** Number of usage signals (billed turns) folded into this rollup. */
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Summed USD for signals that carried a cost; absent when none did. */
  totalUsd?: number;
  /** Summed premium requests (the real billing unit for estimated backends). */
  premiumRequests?: number;
  durationMs: number;
}

/**
 * Device-wide "your spend" summary: usage rolled up per (backend, fidelity), plus
 * a grounded USD total that deliberately excludes estimated spend. Cross-session
 * and local-only (ADR-0092 D1/D2) — nothing here syncs off-device.
 */
export interface UsageSummary {
  /** Distinct sessions that contributed at least one run. */
  sessionCount: number;
  /** Total billed turns across every rollup. */
  totalTurns: number;
  rollups: UsageRollup[];
  /**
   * Sum of USD across exact + derived rollups only — a real dollar figure.
   * Estimated backends (premium requests, not a token cost) are excluded so a
   * guess can never inflate the headline. Absent when no grounded signal had USD.
   */
  groundedTotalUsd?: number;
  /** Total premium requests across estimated backends, surfaced separately. */
  totalPremiumRequests: number;
}

/**
 * A discovered, runnable agent definition (packet 09 §3f-bis). Metadata only — the
 * prompt body stays on disk. `sourcePath` is relative to `workspaceRoot`.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  backend: AgentBackend;
  model?: string;
  sourcePath: string;
  workspaceRoot: string;
}

export type PolicyHintSeverity = "info" | "warning" | "block";

export interface PolicyHint {
  id: string;
  sessionId: string;
  runId?: string;
  code: string;
  severity: PolicyHintSeverity;
  message: string;
  createdAt: string;
}

export interface StartRunRequest {
  session: DispatchSession;
  workspaceRoot: string;
  task: string;
  requestedRunId?: string;
  followUpToRunId?: string;
  transcript?: DispatchMessage[];
  launchCommand?: string[];
}

export interface RunHandle {
  runId: string;
  processId?: number;
}

export type WireProtocolVersion = "honeyhub.bridge.v1";

export const wireProtocolVersion: WireProtocolVersion = "honeyhub.bridge.v1";

export type WireFrameKind = "client_command" | "server_event" | "ack" | "error";

export type ClientCommand =
  | { kind: "start"; request: StartRunRequest }
  | { kind: "reply"; runId: string; text: string }
  | { kind: "stop"; runId: string }
  | { kind: "resume"; sessionIdOrTranscript: string }
  | { kind: "reconnect"; request: ReconnectRequest }
  | { kind: "usage_summary" }
  | { kind: "coaching_hints" }
  | { kind: "discover_agents"; workspaceRoot?: string };

export interface ReconnectRequest {
  sessionId: string;
  runId?: string;
  lastEventId?: string;
}

export interface WireFrame {
  protocol: WireProtocolVersion;
  frameId: string;
  kind: WireFrameKind;
  createdAt: string;
  command?: ClientCommand;
  event?: BridgeEvent;
  error?: {
    code: string;
    message: string;
  };
  ackFrameId?: string;
}

export interface BridgeEvent {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
  createdAt: string;
  payload: BridgeEventPayload;
}

export type BridgeEventPayload =
  | { kind: "message"; message: DispatchMessage }
  | { kind: "control"; event: DispatchControlEvent }
  | { kind: "usage"; signal: UsageSignal }
  | { kind: "policy_hint"; hint: PolicyHint }
  | { kind: "status"; status: BridgeStatusEvent }
  | { kind: "artifact"; artifact: DispatchArtifact }
  | { kind: "usage_summary"; summary: UsageSummary }
  | { kind: "coaching_hints"; hints: PolicyHint[] }
  | { kind: "agent_catalog"; agents: AgentDefinition[] };

export interface BridgeStatusEvent {
  state: DispatchRunState;
  backend: AgentBackend;
  repoHint?: string;
  link?: string;
}

// --- Pairing + trust boundary (ADR-0090 D8) ---
// These mirror the bridge's serde shapes. Only token-free views ever reach a sync
// surface, transcript, or notification; the plaintext pairing token appears once
// in PairingGrant (the handshake response) and is never re-surfaced after that
// single hop (ADR-0090 D8 no-secret-leak posture).

export interface BridgeIdentityView {
  deviceId: string;
  displayName: string;
}

export interface PairedDeviceView {
  deviceId: string;
  displayName: string;
  pairedAt: string;
  revoked: boolean;
}

export interface PairingGrant {
  device: PairedDeviceView;
  token: string;
}

// --- State-only notifications (ADR-0090 D7) ---
// A notification carries status/backend/repo/link only — by shape it cannot hold
// prompt text, code, secrets, stack traces, or full paths.

export type NotificationKind =
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "pr_opened";

export interface Notification {
  id: string;
  kind: NotificationKind;
  sessionId: string;
  runId: string;
  backend: AgentBackend;
  repo?: string;
  link?: string;
  createdAt: string;
}

export const defaultClaudeCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: true,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: true,
  usage_derived: false,
  usage_estimated: false
};

/**
 * `codex.local`: message-level streaming, resume-based reply (follow-up-run path),
 * stop + resume, exact tokens with a derived (rate-table) USD.
 */
export const defaultCodexCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: false,
  usage_derived: true,
  usage_estimated: false
};

/**
 * `copilot.local`: token-level streaming, resume-based reply, stop + resume, and
 * premium-requests + duration only, so token/USD figures are estimated.
 */
export const defaultCopilotCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: false,
  usage_derived: false,
  usage_estimated: true
};

export const oneShotCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: false,
  stop_signal: false,
  structured_events: false,
  usage_exact: false,
  usage_derived: false,
  usage_estimated: true
};
