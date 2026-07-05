// A minimal LSP JSON-RPC connection carried over the HoneyHub bridge WS (ADR-0102).
//
// monaco-languageclient (the package) can't be used here: since v2 it requires
// @codingame/monaco-vscode-api, which REPLACES the standalone monaco-editor this app bundles
// (via `loader.config({ monaco })` + `?worker`) and would break monaco-yaml + the offline
// Tauri build. So we speak LSP directly: the canonical request/notification descriptors and
// types come from `vscode-languageserver-protocol` (version-aligned with the bundled Monaco),
// and this file is a tiny, dependency-free JSON-RPC layer over a transport — no RAL, no
// browser-only subpath, fully offline, fully unit-testable.

/** The message pipe the connection rides on. `send` frames one JSON-RPC message toward the
    server (the bridge writes it to stdin); `onMessage` delivers the server's messages back.
    Abstracted so the connection is testable without a real bridge WebSocket. */
export interface LspTransport {
  send(message: unknown): void;
  /** Register an inbound-message handler; returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void;
}

/** A JSON-RPC error object as it appears on the wire. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/** A live LSP connection: request/response, notifications both ways. */
export interface BridgeLspConnection {
  /** Send a request and resolve with its result (rejects on an error response or disposal). */
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R>;
  /** Send a notification (fire-and-forget). */
  sendNotification(method: string, params?: unknown): void;
  /** Handle a server notification (last registration for a method wins). */
  onNotification(method: string, handler: (params: unknown) => void): void;
  /** Handle a server->client request; the return value becomes the response result. */
  onRequest(method: string, handler: (params: unknown) => unknown): void;
  /** Tear down: reject pending requests and stop listening. */
  dispose(): void;
}

// JSON-RPC standard error codes we use for server->client requests we can't satisfy.
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

let nextRequestId = 1;

/** Build a JSON-RPC connection over `transport`. Pure: no Monaco, no bridge, no globals
    beyond a shared request-id counter (ids only need per-connection uniqueness). */
export function createBridgeLspConnection(transport: LspTransport): BridgeLspConnection {
  const pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestHandlers = new Map<string, (params: unknown) => unknown>();
  let disposed = false;

  const unsubscribe = transport.onMessage((raw) => {
    if (raw === null || typeof raw !== "object") {
      return;
    }
    const message = raw as JsonRpcMessage;
    const hasId = message.id !== undefined;
    const hasMethod = typeof message.method === "string";

    // Response to one of our requests (id, no method).
    if (hasId && !hasMethod) {
      const entry = pending.get(message.id as JsonRpcId);
      if (entry === undefined) {
        return;
      }
      pending.delete(message.id as JsonRpcId);
      if (message.error !== undefined) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // Server -> client request (id AND method): must be answered so the server doesn't hang.
    if (hasId && hasMethod) {
      const id = message.id as JsonRpcId;
      const method = message.method as string;
      const respond = (result: unknown, error?: JsonRpcError): void => {
        transport.send(
          error === undefined
            ? { jsonrpc: "2.0", id, result: result ?? null }
            : { jsonrpc: "2.0", id, error }
        );
      };
      const handler = requestHandlers.get(method);
      if (handler === undefined) {
        respond(null, { code: METHOD_NOT_FOUND, message: `method not handled: ${method}` });
        return;
      }
      try {
        respond(handler(message.params));
      } catch (error) {
        respond(null, {
          code: INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // Notification (method, no id).
    if (hasMethod) {
      notificationHandlers.get(message.method as string)?.(message.params);
    }
  });

  return {
    sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
      if (disposed) {
        return Promise.reject(new Error("lsp connection disposed"));
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        transport.send(
          params === undefined
            ? { jsonrpc: "2.0", id, method }
            : { jsonrpc: "2.0", id, method, params }
        );
      });
    },
    sendNotification(method: string, params?: unknown): void {
      if (disposed) {
        return;
      }
      transport.send(
        params === undefined
          ? { jsonrpc: "2.0", method }
          : { jsonrpc: "2.0", method, params }
      );
    },
    onNotification(method: string, handler: (params: unknown) => void): void {
      notificationHandlers.set(method, handler);
    },
    onRequest(method: string, handler: (params: unknown) => unknown): void {
      requestHandlers.set(method, handler);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const entry of pending.values()) {
        entry.reject(new Error("lsp connection disposed"));
      }
      pending.clear();
    }
  };
}
