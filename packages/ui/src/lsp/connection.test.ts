import { describe, expect, it, vi } from "vitest";
import { createBridgeLspConnection, type LspTransport } from "./connection";

/** A transport with a manual pump: `send` records outgoing messages, `deliver` feeds an inbound
    message to the connection. */
function fakeTransport(): {
  transport: LspTransport;
  sent: Array<Record<string, unknown>>;
  deliver: (message: unknown) => void;
} {
  let handler: ((message: unknown) => void) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  return {
    transport: {
      send: (message) => {
        sent.push(message as Record<string, unknown>);
      },
      onMessage: (h) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      }
    },
    sent,
    deliver: (message) => handler?.(message)
  };
}

describe("createBridgeLspConnection", () => {
  it("correlates a request with its response by id", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const connection = createBridgeLspConnection(transport);

    const pending = connection.sendRequest<{ ok: boolean }>("textDocument/completion", { a: 1 });
    const request = sent[0];
    expect(request?.method).toBe("textDocument/completion");
    expect(request?.params).toEqual({ a: 1 });
    expect(request?.id).not.toBeUndefined();

    deliver({ jsonrpc: "2.0", id: request?.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects a request when the server returns an error", async () => {
    const { transport, sent, deliver } = fakeTransport();
    const connection = createBridgeLspConnection(transport);
    const pending = connection.sendRequest("initialize");
    deliver({ jsonrpc: "2.0", id: sent[0]?.id, error: { code: -32603, message: "boom" } });
    await expect(pending).rejects.toThrow("boom");
  });

  it("dispatches server notifications to the registered handler", () => {
    const { transport, deliver } = fakeTransport();
    const connection = createBridgeLspConnection(transport);
    const onDiagnostics = vi.fn();
    connection.onNotification("textDocument/publishDiagnostics", onDiagnostics);
    deliver({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a" } });
    expect(onDiagnostics).toHaveBeenCalledWith({ uri: "file:///a" });
  });

  it("answers a server->client request from its handler", () => {
    const { transport, sent, deliver } = fakeTransport();
    const connection = createBridgeLspConnection(transport);
    connection.onRequest("workspace/configuration", (params) => {
      const items = (params as { items: unknown[] }).items;
      return items.map(() => null);
    });
    deliver({ jsonrpc: "2.0", id: 42, method: "workspace/configuration", params: { items: [{}, {}] } });
    const response = sent.find((message) => message.id === 42);
    expect(response?.result).toEqual([null, null]);
  });

  it("answers an unhandled server request with method-not-found so the server never hangs", () => {
    const { transport, sent, deliver } = fakeTransport();
    createBridgeLspConnection(transport);
    deliver({ jsonrpc: "2.0", id: 7, method: "window/showMessageRequest", params: {} });
    const response = sent.find((message) => message.id === 7);
    expect((response?.error as { code: number }).code).toBe(-32601);
  });

  it("rejects pending requests on dispose and stops listening", async () => {
    const { transport } = fakeTransport();
    const connection = createBridgeLspConnection(transport);
    const pending = connection.sendRequest("initialize");
    connection.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await expect(connection.sendRequest("hover")).rejects.toThrow("disposed");
  });

  it("fails a request fast when the transport refuses the send", async () => {
    // A bridge denial (lsp_uri_denied / lsp_method_denied / backpressure / not running)
    // rejects the lspSend promise; the pending request must reject instead of hanging on
    // a response that will never come.
    let handler: ((message: unknown) => void) | undefined;
    const refusing: LspTransport = {
      send: () => Promise.reject(new Error("lsp_backpressure: frame dropped")),
      onMessage: (h) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      }
    };
    const connection = createBridgeLspConnection(refusing);
    await expect(connection.sendRequest("textDocument/hover")).rejects.toThrow("lsp_backpressure");
    // A late response for that id (there will never be one, but defensively) is ignored.
    handler?.({ jsonrpc: "2.0", id: 1, result: {} });

    // Notifications stay fire-and-forget: a refused send must not throw or reject.
    expect(() => connection.sendNotification("textDocument/didChange", {})).not.toThrow();
  });

  it("times out a request that never gets a response", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const connection = createBridgeLspConnection(transport, 5000);
      const pending = connection.sendRequest("textDocument/hover");
      const assertion = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when a response arrives in time", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sent, deliver } = fakeTransport();
      const connection = createBridgeLspConnection(transport, 5000);
      const pending = connection.sendRequest<{ ok: boolean }>("textDocument/hover");
      deliver({ jsonrpc: "2.0", id: sent[0]?.id, result: { ok: true } });
      await expect(pending).resolves.toEqual({ ok: true });
      // Advancing past the timeout must not throw an unhandled rejection.
      await vi.advanceTimersByTimeAsync(6000);
    } finally {
      vi.useRealTimers();
    }
  });
});
