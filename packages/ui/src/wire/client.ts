import type { BridgeEvent, JobProbe, StartRunRequest } from "@honeydrunk/honeyhub-types";

// The PWA's view of the packet-04 wire protocol. The run screen depends only on
// this seam, so the same UI drives a mock (tests / offline demo) and, once the
// bridge transport server lands (the relay/shell bringup), a real WebSocket
// client that presents the pairing token on connect — without any UI change.

export type WireEventHandler = (event: BridgeEvent) => void;

export interface StartedRun {
  runId: string;
}

export interface WireClient {
  /** Begin a run; the bridge streams events for it via `subscribe`. */
  start(request: StartRunRequest): Promise<StartedRun>;
  /** Send a live, same-process reply into an active run (e.g. answering
      `needs_input`). A follow-up after completion is a new run via `start`
      (`StartRunRequest.followUpToRunId` + `transcript`), not a reply here. */
  reply(runId: string, text: string): Promise<void>;
  /** Request graceful cancellation of a run. */
  stop(runId: string): Promise<void>;
  /** Ask the host for the device-wide "your spend" summary. The answer arrives as
      a `usage_summary` server event via `subscribe` (this resolves on the host's
      ack, not with the summary itself), so the caller listens for the event. */
  requestUsageSummary(): Promise<void>;
  /** Ask the host for the cross-session coaching advisories. The answer arrives as
      a `coaching_hints` server event via `subscribe` (this resolves on the ack). */
  requestCoachingHints(): Promise<void>;
  /** Discover the user's own agent definitions. With a `workspaceRoot` it scopes to
      that allowlisted root; omitted, every allowlisted root is scanned. The answer
      arrives as an `agent_catalog` server event via `subscribe`. */
  discoverAgents(workspaceRoot?: string): Promise<void>;
  /** Discover which backend CLIs are installed on this machine and the models they
      offer. The webview cannot see the host, so it asks the bridge. The answer
      arrives as a `backend_catalog` server event via `subscribe`. */
  discoverBackends(): Promise<void>;
  /** Replace the bridge's workspace allowlist with the repo locations the user picked,
      scoping file reads + launches to them. Resolves on the host's ack. */
  setWorkspaceRoots(roots: string[]): Promise<void>;
  /** Browse a directory for the repo/file picker (names + kinds only). Omit `path`
      for the top level. The answer arrives as a `dir_listing` event via `subscribe`
      (correlate by its `path`). */
  browseDir(path?: string): Promise<void>;
  /** Read a file's text for the read-only viewer. The answer arrives as a
      `file_contents` event via `subscribe` (correlate by its `path`); a denied/binary/
      oversized read rejects this promise with the bridge's error. */
  readFile(path: string): Promise<void>;
  /** Recursively search a root for files whose name contains `query`. The answer
      arrives as a `search_results` event via `subscribe` (correlate by root+query). */
  searchFiles(root: string, query: string): Promise<void>;
  /** Resolve a `.code-workspace` file to the repo folders it references. The answer
      arrives as a `workspace_folders` event via `subscribe`. */
  resolveWorkspaceFile(path: string): Promise<void>;
  /** Author a Claude agent definition (`.claude/agents/<name>.md`). Omit
      `workspaceRoot` to write the user-global agent. The answer arrives as an
      `agent_written` event via `subscribe`; the caller then re-discovers. */
  writeAgent(input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    workspaceRoot?: string;
  }): Promise<void>;
  /** Snapshot the local processes + known-job health. The answer arrives as a
      `job_snapshot` event via `subscribe`. Optional `extraProbes` / `extraTaskKeywords`
      (the user's configurable job patterns) are merged onto the built-in set server-side. */
  listJobs(options?: {
    extraProbes?: JobProbe[];
    extraTaskKeywords?: string[];
  }): Promise<void>;
  /** Detect each backend CLI's installed version. The answer arrives as an
      `environment_info` event via `subscribe`. */
  detectEnvironment(): Promise<void>;
  /** List this host's reachable addresses for mobile pairing. The answer arrives as a
      `network_info` event via `subscribe`. */
  listNetwork(): Promise<void>;
  /** Fetch work items from the opt-in connectors named in `sources` (e.g. `["github"]`).
      The answer arrives as a `work_snapshot` event via `subscribe`. */
  listWork(sources: string[]): Promise<void>;
  /** Snapshot Azure Service Bus (namespaces + queue/subscription counts). The answer arrives
      as a `service_bus_snapshot` event via `subscribe`. */
  listServiceBus(): Promise<void>;
  /** Non-destructively peek messages from a Service Bus queue (or topic subscription). The
      answer arrives as a `service_bus_peek` event via `subscribe`. */
  peekServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
    count?: number;
  }): Promise<void>;
  /** **Destructive**: move dead-letter messages back to the source (confirmation-gated in the
      UI). The answer arrives as a `service_bus_resubmit` event via `subscribe`. */
  resubmitDeadLetter(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    count?: number;
  }): Promise<void>;
  /** **Destructive**: drain all messages from a queue/subscription (or its DLQ), confirmation-
      gated in the UI. The answer arrives as a `service_bus_purge` event via `subscribe`. */
  purgeServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void>;
  /** Publish a message to a queue/topic (confirmation-gated in the UI). The answer arrives as
      a `service_bus_send` event via `subscribe`. */
  sendServiceBus(request: {
    namespace: string;
    entity: string;
    body: string;
    subject?: string;
    contentType?: string;
  }): Promise<void>;
  /** **Destructive**: consume + remove the next message from a queue/subscription (or its DLQ),
      confirmation-gated. The answer arrives as a `service_bus_receive` event via `subscribe`. */
  receiveServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void>;
  /** Summarize a Grafana instance (health + dashboards). `baseUrl`/`token` are the cockpit's
      locally-held config. The answer arrives as a `grafana_summary` event via `subscribe`. */
  grafanaSummary(baseUrl: string, token: string): Promise<void>;
  /** Summarize a Sentry project's unresolved issues. Config is the cockpit's locally-held
      values. The answer arrives as a `sentry_summary` event via `subscribe`. */
  sentrySummary(config: {
    baseUrl: string;
    org: string;
    project: string;
    token: string;
  }): Promise<void>;
  /** Read a repo's git status (allowlist-gated). The answer arrives as a `git_status`
      event via `subscribe` (correlate by its `root`). */
  gitStatus(root: string): Promise<void>;
  /** Read a repo's read-only diff (allowlist-gated). The answer arrives as a `git_diff`
      event via `subscribe` (correlate by root + path). */
  gitDiff(root: string, path?: string): Promise<void>;
  /** List the locally-persisted (durable) sessions. The answer arrives as a
      `session_list` event via `subscribe`. */
  listSessions(): Promise<void>;
  /** Read a persisted session's runs + transcript, to reopen it. The answer arrives as a
      `session_detail` event via `subscribe` (correlate by `sessionId`). */
  sessionDetail(sessionId: string): Promise<void>;
  /** Read the roadmap snapshot (parsed from the Architecture repo's initiatives). The
      answer arrives as a `roadmap` event via `subscribe` (`found:false` = no repo). */
  roadmap(): Promise<void>;
  /** Scaffold a starter Architecture repo (when none exists). Omit `name`/`location` for
      sensible defaults. The answer arrives as a `roadmap` event (the new repo), or this
      rejects with the bridge error (e.g. already-exists). */
  scaffoldArchitecture(input: { name?: string; location?: string }): Promise<void>;
  /** Fast-forward the Architecture repo (`git pull --ff-only`) and re-read it. The answer
      arrives as a `roadmap` event; rejects with the git error (e.g. diverged/dirty). */
  pullArchitecture(): Promise<void>;
  /** Subscribe to bridge events; returns an unsubscribe function. */
  subscribe(handler: WireEventHandler): () => void;
}
