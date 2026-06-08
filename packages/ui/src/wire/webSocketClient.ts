import type {
  BridgeEvent,
  ClientCommand,
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
  private handlers = new Set<WireEventHandler>();
  private queue: Array<{ frameId: string; data: string }> = [];
  private open = false;
  private closed = false;
  private pending = new Map<string, Pending>();

  constructor(
    private socket: WireSocket,
    private responseTimeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS
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
}
