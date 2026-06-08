import { describe, expect, it } from "vitest";
import type { BridgeEvent, WireFrame } from "@honeydrunk/honeyhub-types";
import { WebSocketWireClient, type WireSocket } from "./webSocketClient";

class FakeSocket implements WireSocket {
  sent: string[] = [];
  private messageHandler?: (data: string) => void;
  private openHandler?: () => void;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }
  open(): void {
    this.openHandler?.();
  }
  deliver(frame: WireFrame): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
}

describe("WebSocketWireClient", () => {
  it("queues commands until open, then flushes them", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);

    await client.start({
      session: {
        id: "s1",
        backend: "claude.local",
        title: "t",
        workspaceRoot: "/w",
        createdAt: "2026-06-07T12:00:00Z",
        updatedAt: "2026-06-07T12:00:00Z"
      },
      workspaceRoot: "/w",
      task: "do it",
      requestedRunId: "run-1"
    });
    // Not open yet: nothing sent.
    expect(socket.sent).toHaveLength(0);

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const [first] = socket.sent;
    const frame = JSON.parse(first ?? "{}") as WireFrame;
    expect(frame.kind).toBe("client_command");
    expect(frame.command?.kind).toBe("start");
  });

  it("delivers server events to subscribers", () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);
    const received: BridgeEvent[] = [];
    client.subscribe((event) => received.push(event));

    socket.deliver({
      protocol: "honeyhub.bridge.v1",
      frameId: "f1",
      kind: "server_event",
      createdAt: "2026-06-07T12:00:00Z",
      event: {
        id: "e1",
        sessionId: "s1",
        runId: "run-1",
        sequence: 0,
        createdAt: "2026-06-07T12:00:00Z",
        payload: {
          kind: "status",
          status: { state: "needs_input", backend: "claude.local" }
        }
      }
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.payload.kind).toBe("status");
  });

  it("sends reply and stop commands once open", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);
    socket.open();

    await client.reply("run-1", "continue");
    await client.stop("run-1");

    const kinds = socket.sent.map((raw) => (JSON.parse(raw) as WireFrame).command?.kind);
    expect(kinds).toEqual(["reply", "stop"]);
  });
});
