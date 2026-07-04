import type {
  AgentBackend,
  BridgeEvent,
  ClientCommand,
  JobProbe,
  StartRunRequest,
  WireFrame
} from "@honeydrunk/honeyhub-types";
import { wireProtocolVersion } from "@honeydrunk/honeyhub-types";
import type { StartedRun, WireClient, WireEventHandler } from "./client";

// A real WireClient over the bridge host's WebSocket (the honeyhub.bridge.v1
// transport). It implements the same seam the run screen already uses, so it
// drops in with no UI change. The pairing token rides the connection URL
// (`ws://host/?token=...`), exactly as the bridge host prints it.

// A minimal socket abstraction so the client is unit-testable without a browser
// WebSocket. `browserSocket` wraps the real global WebSocket.
export interface WireSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
}

/** Derive the bridge WebSocket URL from the page's own location + a token, so a
    PWA served by the bridge host (same origin) auto-connects to its `/ws`. */
export function bridgeWsUrl(location: { protocol: string; host: string }, token: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export function browserSocket(url: string): WireSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (handler) =>
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          handler(event.data);
        }
      }),
    onOpen: (handler) => ws.addEventListener("open", handler),
    onClose: (handler) => {
      ws.addEventListener("close", () => handler());
      ws.addEventListener("error", () => handler());
    }
  };
}

/** Ignore frames longer than this (UTF-16 code units) — a guard against a
    buggy/hostile host sending an enormous payload. */
const MAX_FRAME_CHARS = 1_000_000;

function frame(command: ClientCommand): WireFrame {
  return {
    protocol: wireProtocolVersion,
    frameId: crypto.randomUUID(),
    kind: "client_command",
    createdAt: new Date().toISOString(),
    command
  };
}

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** How long to wait for the host's ack/error for a command before failing. */
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;

export class WebSocketWireClient implements WireClient {
  private readonly handlers = new Set<WireEventHandler>();
  private queue: Array<{ frameId: string; data: string }> = [];
  private open = false;
  private closed = false;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly socket: WireSocket,
    private readonly responseTimeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS
  ) {
    this.socket.onOpen(() => {
      // Flush queued frames before marking open so ordering is unambiguous, and
      // skip any whose command already settled (timed out / rejected) while
      // queued — so a failed command is not silently executed later.
      const queued = this.queue;
      this.queue = [];
      for (const item of queued) {
        if (this.pending.has(item.frameId)) {
          this.socket.send(item.data);
        }
      }
      this.open = true;
    });
    this.socket.onMessage((data) => this.receive(data));
    this.socket.onClose(() => this.onSocketClosed());
  }

  /** Convenience: connect to a full cockpit URL (token already in the query). */
  static connect(url: string): WebSocketWireClient {
    if (!/^wss?:\/\//.test(url)) {
      throw new Error("bridge URL must start with ws:// or wss://");
    }
    return new WebSocketWireClient(browserSocket(url));
  }

  private onSocketClosed(): void {
    this.closed = true;
    const error = new Error("bridge connection closed");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(data: string): void {
    if (data.length > MAX_FRAME_CHARS) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null || typeof (raw as WireFrame).kind !== "string") {
      return;
    }
    const parsed = raw as WireFrame;
    // Resolve/reject the command that this frame answers (host tags acks and
    // command errors with the originating frame id), so launch-gate failures
    // surface to the caller instead of being silently dropped.
    if (parsed.kind === "ack" && parsed.ackFrameId !== undefined) {
      this.settle(parsed.ackFrameId, undefined);
      return;
    }
    if (parsed.kind === "error") {
      const message = parsed.error?.message ?? "bridge error";
      if (parsed.ackFrameId !== undefined) {
        this.settle(parsed.ackFrameId, new Error(message));
      }
      return;
    }
    if (parsed.kind === "server_event" && parsed.event !== undefined) {
      const event: BridgeEvent = parsed.event;
      for (const handler of this.handlers) {
        handler(event);
      }
    }
  }

  private settle(frameId: string, error: Error | undefined): void {
    const pending = this.pending.get(frameId);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(frameId);
    if (error === undefined) {
      pending.resolve();
    } else {
      pending.reject(error);
    }
  }

  // Send a command and resolve when the host acks it (or reject on error/timeout).
  private dispatch(command: ClientCommand): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("bridge connection closed"));
    }
    const wireFrame = frame(command);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(wireFrame.frameId)) {
          reject(new Error("the bridge did not respond"));
        }
      }, this.responseTimeoutMs);
      this.pending.set(wireFrame.frameId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      const data = JSON.stringify(wireFrame);
      if (this.open) {
        this.socket.send(data);
      } else {
        this.queue.push({ frameId: wireFrame.frameId, data });
      }
    });
  }

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async start(request: StartRunRequest): Promise<StartedRun> {
    const runId = request.requestedRunId;
    if (runId === undefined) {
      throw new Error("WebSocketWireClient.start requires request.requestedRunId");
    }
    await this.dispatch({ kind: "start", request });
    return { runId };
  }

  async reply(runId: string, text: string): Promise<void> {
    await this.dispatch({ kind: "reply", runId, text });
  }

  async stop(runId: string): Promise<void> {
    await this.dispatch({ kind: "stop", runId });
  }

  async requestUsageSummary(): Promise<void> {
    await this.dispatch({ kind: "usage_summary" });
  }

  async requestCoachingHints(): Promise<void> {
    await this.dispatch({ kind: "coaching_hints" });
  }

  async discoverAgents(workspaceRoot?: string): Promise<void> {
    await this.dispatch(
      workspaceRoot === undefined
        ? { kind: "discover_agents" }
        : { kind: "discover_agents", workspaceRoot }
    );
  }

  async discoverBackends(): Promise<void> {
    await this.dispatch({ kind: "discover_backends" });
  }

  async setWorkspaceRoots(roots: string[]): Promise<void> {
    await this.dispatch({ kind: "set_workspace_roots", roots });
  }

  async browseDir(path?: string): Promise<void> {
    await this.dispatch(
      path === undefined ? { kind: "browse_dir" } : { kind: "browse_dir", path }
    );
  }

  async readFile(path: string): Promise<void> {
    await this.dispatch({ kind: "read_file", path });
  }

  async searchFiles(root: string, query: string): Promise<void> {
    await this.dispatch({ kind: "search_files", root, query });
  }

  async resolveWorkspaceFile(path: string): Promise<void> {
    await this.dispatch({ kind: "resolve_workspace_file", path });
  }

  async writeAgent(input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    workspaceRoot?: string;
  }): Promise<void> {
    await this.dispatch({
      kind: "write_agent",
      name: input.name,
      description: input.description,
      body: input.body,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot })
    });
  }

  async listJobs(options?: {
    extraProbes?: JobProbe[];
    extraTaskKeywords?: string[];
  }): Promise<void> {
    await this.dispatch({
      kind: "list_jobs",
      ...(options?.extraProbes && options.extraProbes.length > 0
        ? { extraProbes: options.extraProbes }
        : {}),
      ...(options?.extraTaskKeywords && options.extraTaskKeywords.length > 0
        ? { extraTaskKeywords: options.extraTaskKeywords }
        : {}),
    });
  }

  async detectEnvironment(): Promise<void> {
    await this.dispatch({ kind: "detect_environment" });
  }

  async listNetwork(): Promise<void> {
    await this.dispatch({ kind: "list_network" });
  }

  async listWork(sources: string[]): Promise<void> {
    await this.dispatch({
      kind: "list_work",
      ...(sources.length > 0 ? { sources } : {})
    });
  }

  async listServiceBus(): Promise<void> {
    await this.dispatch({ kind: "list_service_bus" });
  }

  async listAzureSubscriptions(): Promise<void> {
    await this.dispatch({ kind: "list_azure_subscriptions" });
  }

  async listKeyVaults(subscriptionIds: string[]): Promise<void> {
    await this.dispatch({
      kind: "list_key_vaults",
      ...(subscriptionIds.length > 0 ? { subscriptionIds } : {})
    });
  }

  async listVaultObjects(vault: string, subscriptionId: string): Promise<void> {
    await this.dispatch({ kind: "list_vault_objects", vault, subscriptionId });
  }

  async revealSecret(vault: string, subscriptionId: string, name: string): Promise<void> {
    await this.dispatch({ kind: "reveal_secret", vault, subscriptionId, name });
  }

  async scanKeyVaultExpiry(subscriptionIds: string[]): Promise<void> {
    await this.dispatch({
      kind: "scan_key_vault_expiry",
      ...(subscriptionIds.length > 0 ? { subscriptionIds } : {})
    });
  }

  async peekServiceBus(request: {
    namespace: string;
    connectionString?: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
    count?: number;
  }): Promise<void> {
    await this.dispatch({
      kind: "peek_service_bus",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      entity: request.entity,
      ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
      ...(request.deadLetter === undefined ? {} : { deadLetter: request.deadLetter }),
      ...(request.count === undefined ? {} : { count: request.count })
    });
  }

  async resubmitDeadLetter(request: {
    namespace: string;
    connectionString?: string;
    entity: string;
    subscription?: string;
    count?: number;
  }): Promise<void> {
    await this.dispatch({
      kind: "resubmit_dead_letter",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      entity: request.entity,
      ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
      ...(request.count === undefined ? {} : { count: request.count })
    });
  }

  async purgeServiceBus(request: {
    namespace: string;
    connectionString?: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void> {
    await this.dispatch({
      kind: "purge_service_bus",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      entity: request.entity,
      ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
      ...(request.deadLetter === undefined ? {} : { deadLetter: request.deadLetter })
    });
  }

  async sendServiceBus(request: {
    namespace: string;
    connectionString?: string;
    entity: string;
    body: string;
    subject?: string;
    contentType?: string;
  }): Promise<void> {
    await this.dispatch({
      kind: "send_service_bus",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      entity: request.entity,
      body: request.body,
      ...(request.subject === undefined ? {} : { subject: request.subject }),
      ...(request.contentType === undefined ? {} : { contentType: request.contentType })
    });
  }

  async receiveServiceBus(request: {
    namespace: string;
    connectionString?: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void> {
    await this.dispatch({
      kind: "receive_service_bus",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      entity: request.entity,
      ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
      ...(request.deadLetter === undefined ? {} : { deadLetter: request.deadLetter })
    });
  }

  async listServiceBusEntities(request: {
    namespace: string;
    connectionString?: string;
  }): Promise<void> {
    await this.dispatch({
      kind: "list_service_bus_entities",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString })
    });
  }

  async manageServiceBus(request: {
    namespace: string;
    connectionString?: string;
    op: "create" | "delete" | "update";
    entityKind: "queue" | "topic" | "subscription";
    entity: string;
    subscription?: string;
    props?: import("@honeydrunk/honeyhub-types").SbEntityProps;
  }): Promise<void> {
    await this.dispatch({
      kind: "manage_service_bus",
      namespace: request.namespace,
      ...(request.connectionString === undefined ? {} : { connectionString: request.connectionString }),
      op: request.op,
      entityKind: request.entityKind,
      entity: request.entity,
      ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
      ...(request.props === undefined ? {} : { props: request.props })
    });
  }

  async grafanaSummary(baseUrl: string, token: string): Promise<void> {
    await this.dispatch({ kind: "grafana_summary", baseUrl, token });
  }

  async sentrySummary(config: {
    baseUrl: string;
    org: string;
    project: string;
    token: string;
  }): Promise<void> {
    await this.dispatch({
      kind: "sentry_summary",
      baseUrl: config.baseUrl,
      org: config.org,
      project: config.project,
      token: config.token
    });
  }

  async gitStatus(root: string): Promise<void> {
    await this.dispatch({ kind: "git_status", root });
  }

  async gitDiff(root: string, path?: string): Promise<void> {
    await this.dispatch(
      path === undefined ? { kind: "git_diff", root } : { kind: "git_diff", root, path }
    );
  }

  async gitOverview(root: string): Promise<void> {
    await this.dispatch({ kind: "git_overview", root });
  }

  async gitBranches(root: string): Promise<void> {
    await this.dispatch({ kind: "git_branches", root });
  }

  async gitStage(root: string, paths: string[]): Promise<void> {
    await this.dispatch({ kind: "git_stage", root, paths });
  }

  async gitUnstage(root: string, paths: string[]): Promise<void> {
    await this.dispatch({ kind: "git_unstage", root, paths });
  }

  async gitCommit(root: string, message: string): Promise<void> {
    await this.dispatch({ kind: "git_commit", root, message });
  }

  async gitPush(root: string): Promise<void> {
    await this.dispatch({ kind: "git_push", root });
  }

  async gitPull(root: string): Promise<void> {
    await this.dispatch({ kind: "git_pull", root });
  }

  async gitCheckout(root: string, name: string, create?: boolean): Promise<void> {
    await this.dispatch(
      create === undefined
        ? { kind: "git_checkout", root, name }
        : { kind: "git_checkout", root, name, create }
    );
  }

  async gitDiscard(root: string, paths: string[], untracked?: boolean): Promise<void> {
    await this.dispatch(
      untracked === undefined
        ? { kind: "git_discard", root, paths }
        : { kind: "git_discard", root, paths, untracked }
    );
  }

  async gitDiscardAll(root: string): Promise<void> {
    await this.dispatch({ kind: "git_discard_all", root });
  }

  async gitDeleteBranch(root: string, name: string, force?: boolean): Promise<void> {
    await this.dispatch(
      force === undefined
        ? { kind: "git_delete_branch", root, name }
        : { kind: "git_delete_branch", root, name, force }
    );
  }

  async listSessions(): Promise<void> {
    await this.dispatch({ kind: "list_sessions" });
  }

  async sessionDetail(sessionId: string): Promise<void> {
    await this.dispatch({ kind: "session_detail", sessionId });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.dispatch({ kind: "rename_session", sessionId, title });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.dispatch({ kind: "delete_session", sessionId });
  }

  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    await this.dispatch({ kind: "pin_session", sessionId, pinned });
  }

  async probeUsage(backend: AgentBackend): Promise<void> {
    await this.dispatch({ kind: "probe_usage", backend });
  }

  async roadmap(): Promise<void> {
    await this.dispatch({ kind: "roadmap" });
  }

  async scaffoldArchitecture(input: { name?: string; location?: string }): Promise<void> {
    await this.dispatch({
      kind: "scaffold_architecture",
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.location === undefined ? {} : { location: input.location })
    });
  }

  async pullArchitecture(): Promise<void> {
    await this.dispatch({ kind: "pull_architecture" });
  }

  async runCheck(root: string, checkId: string): Promise<void> {
    await this.dispatch({ kind: "run_check", root, check: checkId });
  }
}
