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
    Abstracted so the connection is testable without a real bridge WebSocket. `send` may
    return a promise: a rejection means the bridge REFUSED the frame (URI/method denial,
    backpressure, no running server), and a pending request must fail fast instead of
    hanging on a response that will never come. */
export interface LspTransport {
  send(message: unknown): void | Promise<void>;
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
  /** Send a notification and return the send promise, so the caller can react to a
      refusal (e.g. a dropped `didChange` that must trigger a document resync). Rejects if
      the transport refuses the frame or the connection is disposed. */
  sendNotificationTracked(method: string, params?: unknown): Promise<void>;
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

/** How long a request waits for its response before it is failed. A server can start but
    never answer `initialize`/`completion`/`hover`/`rename`; without a bound the request
    would hang forever and the editor feature would spin. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A per-connection-unique id prefix. Language servers can be SHARED across cockpit
    clients (device-wide `lsp_message` broadcast), and each client allocates request ids
    independently: without a unique prefix, client A's response to request `5` would
    resolve client B's own pending `5`, cross-wiring hovers/completions/rename edits. A
    per-connection prefix means a foreign response's id is never in this connection's
    pending map, so it is ignored. */
function connectionIdPrefix(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Build a JSON-RPC connection over `transport`. Pure: no Monaco, no bridge, no globals.
    Request ids are prefixed with a per-connection-unique token so a shared server's
    responses can never cross-resolve between clients. `requestTimeoutMs` bounds how long a
    request waits for its response. */
export function createBridgeLspConnection(
  transport: LspTransport,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): BridgeLspConnection {
  const pending = new Map<JsonRpcId, PendingRequest>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestHandlers = new Map<string, (params: unknown) => unknown>();
  const idPrefix = connectionIdPrefix();
  let requestSeq = 0;
  let disposed = false;

  /** Remove a pending request and clear its timeout, returning it so the caller settles it. */
  const take = (id: JsonRpcId): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    pending.delete(id);
    return entry;
  };

  const unsubscribe = transport.onMessage((raw) => {
    if (raw === null || typeof raw !== "object") {
      return;
    }
    const message = raw as JsonRpcMessage;
    const hasId = message.id !== undefined;
    const hasMethod = typeof message.method === "string";

    // Response to one of our requests (id, no method).
    if (hasId && !hasMethod) {
      const entry = take(message.id as JsonRpcId);
      if (entry === undefined) {
        return;
      }
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
        // A refused response is unrecoverable from here; the bridge audit-logs it.
        void Promise.resolve(
          transport.send(
            error === undefined
              ? { jsonrpc: "2.0", id, result: result ?? null }
              : { jsonrpc: "2.0", id, error }
          )
        ).catch(() => undefined);
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
      const id = `${idPrefix}-${requestSeq}`;
      requestSeq += 1;
      return new Promise<R>((resolve, reject) => {
        const entry: PendingRequest = { resolve: resolve as (value: unknown) => void, reject };
        // Bound the wait: a server that starts but never answers must not hang the request.
        entry.timer = setTimeout(() => {
          const timedOut = take(id);
          timedOut?.reject(new Error(`lsp request '${method}' timed out`));
        }, requestTimeoutMs);
        pending.set(id, entry);
        // A refused send (bridge denial, backpressure, dead socket) means no response
        // will ever arrive: fail the request now instead of leaving it pending.
        void Promise.resolve(
          transport.send(
            params === undefined
              ? { jsonrpc: "2.0", id, method }
              : { jsonrpc: "2.0", id, method, params }
          )
        ).catch((cause: unknown) => {
          const failed = take(id);
          failed?.reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      });
    },
    sendNotification(method: string, params?: unknown): void {
      if (disposed) {
        return;
      }
      // Notifications are fire-and-forget by protocol; a refusal is logged bridge-side.
      void Promise.resolve(
        transport.send(
          params === undefined
            ? { jsonrpc: "2.0", method }
            : { jsonrpc: "2.0", method, params }
        )
      ).catch(() => undefined);
    },
    sendNotificationTracked(method: string, params?: unknown): Promise<void> {
      if (disposed) {
        return Promise.reject(new Error("lsp connection disposed"));
      }
      return Promise.resolve(
        transport.send(
          params === undefined
            ? { jsonrpc: "2.0", method }
            : { jsonrpc: "2.0", method, params }
        )
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
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        entry.reject(new Error("lsp connection disposed"));
      }
      pending.clear();
    }
  };
}
