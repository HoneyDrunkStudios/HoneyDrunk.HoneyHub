import { describe, expect, it } from "vitest";
import type { BridgeEvent, WireFrame } from "@honeydrunk/honeyhub-types";
import { WebSocketWireClient, type WireSocket } from "./webSocketClient";

class FakeSocket implements WireSocket {
  sent: string[] = [];
  private messageHandler?: (data: string) => void;
  private openHandler?: () => void;
  private closeHandler?: () => void;

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
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  open(): void {
    this.openHandler?.();
  }
  triggerClose(): void {
    this.closeHandler?.();
  }
  deliver(frame: WireFrame): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
  lastFrame(): WireFrame {
    const raw = this.sent[this.sent.length - 1] ?? "{}";
    return JSON.parse(raw) as WireFrame;
  }
}

function ack(ackFrameId: string): WireFrame {
  return {
    protocol: "honeyhub.bridge.v1",
    frameId: "ack",
    kind: "ack",
    createdAt: "2026-06-07T12:00:00Z",
    ackFrameId
  };
}

function startRequest(runId: string) {
  return {
    session: {
      id: "s1",
      backend: "claude.local" as const,
      title: "t",
      workspaceRoot: "/w",
      createdAt: "2026-06-07T12:00:00Z",
      updatedAt: "2026-06-07T12:00:00Z"
    },
    workspaceRoot: "/w",
    task: "do it",
    requestedRunId: runId
  };
}

describe("WebSocketWireClient", () => {
  it("queues commands until open, then flushes and resolves on ack", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);

    const startPromise = client.start(startRequest("run-1"));
    expect(socket.sent).toHaveLength(0); // queued until open

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const sent = socket.lastFrame();
    expect(sent.kind).toBe("client_command");
    expect(sent.command?.kind).toBe("start");

    socket.deliver(ack(sent.frameId));
    await expect(startPromise).resolves.toEqual({ runId: "run-1" });
  });

  it("rejects a command when the host returns an error for it", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);
    socket.open();

    const replyPromise = client.reply("run-1", "continue");
    const sent = socket.lastFrame();
    socket.deliver({
      protocol: "honeyhub.bridge.v1",
      frameId: "err",
      kind: "error",
      createdAt: "2026-06-07T12:00:00Z",
      ackFrameId: sent.frameId,
      error: { code: "workspace_not_allowed", message: "workspace is not allowlisted" }
    });

    await expect(replyPromise).rejects.toThrow("workspace is not allowlisted");
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

  it("rejects pending commands when the socket closes", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);
    socket.open();

    const pending = client.reply("run-1", "continue");
    socket.triggerClose();

    await expect(pending).rejects.toThrow("bridge connection closed");
  });

  it("sends reply and stop commands once open", async () => {
    const socket = new FakeSocket();
    const client = new WebSocketWireClient(socket);
    socket.open();

    const replyPromise = client.reply("run-1", "continue");
    const stopPromise = client.stop("run-1");

    const frames = socket.sent.map((raw) => JSON.parse(raw) as WireFrame);
    expect(frames.map((frame) => frame.command?.kind)).toEqual(["reply", "stop"]);

    for (const frame of frames) {
      socket.deliver(ack(frame.frameId));
    }
    await Promise.all([replyPromise, stopPromise]);
  });
});
