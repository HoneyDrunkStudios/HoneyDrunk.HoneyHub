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

export class WebSocketWireClient implements WireClient {
  private handlers = new Set<WireEventHandler>();
  private queue: string[] = [];
  private open = false;

  constructor(private socket: WireSocket) {
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
    if (parsed.kind === "server_event" && parsed.event !== undefined) {
      const event: BridgeEvent = parsed.event;
      for (const handler of this.handlers) {
        handler(event);
      }
    }
  }

  private dispatch(command: ClientCommand): void {
    const data = JSON.stringify(frame(command));
    if (this.open) {
      this.socket.send(data);
    } else {
      this.queue.push(data);
    }
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
    this.dispatch({ kind: "start", request });
    return { runId };
  }

  async reply(runId: string, text: string): Promise<void> {
    this.dispatch({ kind: "reply", runId, text });
  }

  async stop(runId: string): Promise<void> {
    this.dispatch({ kind: "stop", runId });
  }
}
