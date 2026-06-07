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
  usage_exact: boolean;
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

export type WireProtocolVersion = "honeyhub.bridge.v1";

export const wireProtocolVersion: WireProtocolVersion = "honeyhub.bridge.v1";

export type WireFrameKind = "client_command" | "server_event" | "ack" | "error";

export type ClientCommand =
  | { kind: "start"; request: StartRunRequest }
  | { kind: "reply"; runId: string; text: string }
  | { kind: "stop"; runId: string }
  | { kind: "resume"; sessionIdOrTranscript: string }
  | { kind: "reconnect"; request: ReconnectRequest };

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
  | { kind: "status"; status: BridgeStatusEvent };

export interface BridgeStatusEvent {
  state: DispatchRunState;
  backend: AgentBackend;
  repoHint?: string;
  link?: string;
}

export const defaultClaudeCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: true,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: true,
  usage_estimated: false
};

export const oneShotCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: false,
  stop_signal: false,
  structured_events: false,
  usage_exact: false,
  usage_estimated: true
};
