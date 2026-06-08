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
    onOpen: (handler) => ws.addEventListener("open", handler)
  };
}

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
  private queue: string[] = [];
  private open = false;
  private pending = new Map<string, Pending>();

  constructor(
    private socket: WireSocket,
    private responseTimeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS
  ) {
    this.socket.onOpen(() => {
      this.open = true;
      for (const pending of this.queue) {
        this.socket.send(pending);
      }
      this.queue = [];
    });
    this.socket.onMessage((data) => this.receive(data));
  }

  /** Convenience: connect to a full cockpit URL (token already in the query). */
  static connect(url: string): WebSocketWireClient {
    return new WebSocketWireClient(browserSocket(url));
  }

  private receive(data: string): void {
    let parsed: WireFrame;
    try {
      parsed = JSON.parse(data) as WireFrame;
    } catch {
      return;
    }
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
        this.queue.push(data);
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
}
