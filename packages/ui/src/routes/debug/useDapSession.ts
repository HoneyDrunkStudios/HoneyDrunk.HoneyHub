import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeEvent } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";

// The wire-coordination half of the integrated debugger (ADR-0106 Slice B). It owns one debug
// session over the WireClient seam: open it, speak DAP (breakpoints, stepping, stack, variables,
// evaluate) as request/response pairs correlated by `seq`, and fold the adapter's events into a
// small view model the debug panels render. The bridge is a proxy: it host-gates the launch and
// tree-kills the two processes, but the DAP protocol itself lives here (Monaco ships no debug UI).

/** One DAP stack frame, the subset the call-stack panel and the current-line decoration need. */
export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  /** The source path, when the adapter attached one (used to drive the editor decoration). */
  source?: string;
}

/** One DAP variable (a name/value pair; `variablesReference > 0` means it has children). */
export interface DapVariable {
  name: string;
  value: string;
  variablesReference: number;
}

export type DapStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "terminated"
  | "denied"
  | "error";

export interface DapSession {
  /** The session's lifecycle state, for the panel's status line. */
  status: DapStatus;
  /** The host-assigned session id once open (null before / after). */
  sessionId: string | null;
  /** A short opaque code / message for a stop, denial, or error. */
  detail: string | null;
  /** The thread the debuggee is currently stopped on (null while running / before first stop). */
  stoppedThreadId: number | null;
  /** The call stack of the stopped thread (empty while running). */
  callStack: DapStackFrame[];
  /** Start a debug session for the detected `configId` in `root` with the named `adapterId`. */
  start: (root: string, adapterId: string, configId: string) => void;
  /** Set source breakpoints for a file (replaces the file's set). Safe before or after start. */
  setBreakpoints: (path: string, lines: number[]) => void;
  /** Resume the stopped thread. */
  continue: () => void;
  /** Step over / into / out of the current line. */
  stepOver: () => void;
  stepIn: () => void;
  stepOut: () => void;
  /** Fetch the variables of a scope/variablesReference on demand (for lazy tree expansion). */
  variables: (variablesReference: number) => Promise<DapVariable[]>;
  /** Evaluate an expression in the top stopped frame (watch panel / debug console). */
  evaluate: (expression: string) => Promise<string>;
  /** Stop the session (tree-kills adapter + debuggee host-side). Idempotent. */
  stop: () => void;
}

/** Monotonic fallback for correlation nonces when Web Crypto's randomUUID is unavailable (the
    debug surface is desktop-local-only, but the fallback keeps it total). */
let dapCounter = 0;
function nextOpenId(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  dapCounter += 1;
  return `dap-${dapCounter}`;
}

/** A DAP protocol message (request / response / event), the minimal shape this client reads. */
interface DapMessage {
  type?: string;
  event?: string;
  command?: string;
  seq?: number;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

/**
 * Manage a single debug session over `client`. `onOutput` receives the debuggee's stdout/stderr
 * and debug-console output (the debug-console panel appends it). Actions map to DAP requests; the
 * hook correlates each response by `seq` and folds events into the returned view model.
 */
export function useDapSession(
  client: WireClient,
  onOutput: (text: string) => void
): DapSession {
  const [status, setStatus] = useState<DapStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [stoppedThreadId, setStoppedThreadId] = useState<number | null>(null);
  const [callStack, setCallStack] = useState<DapStackFrame[]>([]);

  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  const sessionIdRef = useRef<string | null>(null);
  // The correlation nonce of the in-flight open, so we adopt the `dap_session_opened` that answers
  // OUR request (the event is broadcast device-wide, self-announcing). Cleared once adopted.
  const pendingOpenIdRef = useRef<string | null>(null);
  // DAP request sequence + the promises awaiting each request's response, keyed by seq.
  const seqRef = useRef(1);
  const pendingRef = useRef(new Map<number, (message: DapMessage) => void>());
  // Breakpoints set before the session opened, replayed once `initialized` arrives.
  const breakpointsRef = useRef(new Map<string, number[]>());

  // Send a DAP request and resolve with its response message (correlated by seq). Rejects if the
  // session is not open. The bridge forwards it to the adapter (and host-gates launch/restart).
  const request = useCallback(
    (command: string, args?: Record<string, unknown>): Promise<DapMessage> => {
      const id = sessionIdRef.current;
      if (id === null) {
        return Promise.reject(new Error("no debug session is open"));
      }
      const seq = seqRef.current;
      seqRef.current += 1;
      const message: DapMessage = { type: "request", seq, command };
      if (args !== undefined) {
        message.arguments = args;
      }
      return new Promise<DapMessage>((resolve) => {
        pendingRef.current.set(seq, resolve);
        void client.sendDap(id, message);
      });
    },
    [client]
  );

  const refreshStack = useCallback(
    async (threadId: number) => {
      const response = await request("stackTrace", { threadId });
      const frames = (response.body?.stackFrames as DapStackFrame[] | undefined) ?? [];
      setCallStack(
        frames.map((frame) => {
          const source = (frame as { source?: { path?: string } }).source?.path;
          const base = { id: frame.id, name: frame.name, line: frame.line, column: frame.column };
          return source === undefined ? base : { ...base, source };
        })
      );
    },
    [request]
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((event: BridgeEvent) => {
      const payload = event.payload;
      if (payload.kind === "dap_session_opened") {
        if (
          pendingOpenIdRef.current !== null &&
          payload.openId === pendingOpenIdRef.current &&
          sessionIdRef.current === null
        ) {
          pendingOpenIdRef.current = null;
          sessionIdRef.current = payload.sessionId;
          setSessionId(payload.sessionId);
          setStatus("running");
        }
        return;
      }
      if (payload.kind === "dap_session_closed") {
        if (payload.sessionId === sessionIdRef.current) {
          sessionIdRef.current = null;
          setSessionId(null);
          setStoppedThreadId(null);
          setCallStack([]);
          pendingRef.current.clear();
          setStatus("terminated");
          setDetail(payload.reason);
        }
        return;
      }
      if (payload.kind !== "dap_message" || payload.sessionId !== sessionIdRef.current) {
        return;
      }
      const message = payload.message as DapMessage;

      // A RESPONSE to one of our requests: resolve the waiting promise.
      if (message.type === "response" && typeof message.request_seq === "number") {
        const resolve = pendingRef.current.get(message.request_seq);
        if (resolve !== undefined) {
          pendingRef.current.delete(message.request_seq);
          resolve(message);
        }
        return;
      }

      // A REVERSE REQUEST from the adapter. `runInTerminal` asks the CLIENT to spawn a process;
      // honoring it blindly would be an adapter-to-client execution vector (ADR-0106: exec stays
      // host-owned). We DENY it rather than run anything the adapter names. Other reverse requests
      // (`startDebugging`) are likewise not auto-honored in Slice B.
      if (message.type === "request" && typeof message.seq === "number") {
        void client.sendDap(sessionIdRef.current, {
          type: "response",
          request_seq: message.seq,
          command: message.command,
          success: false,
          message: "runInTerminal/startDebugging is not permitted from the debug adapter (ADR-0106)"
        });
        return;
      }

      // An EVENT from the adapter.
      if (message.type === "event") {
        switch (message.event) {
          case "initialized": {
            // Replay any breakpoints set before the session opened, then configurationDone.
            for (const [path, lines] of breakpointsRef.current) {
              void request("setBreakpoints", {
                source: { path },
                breakpoints: lines.map((line) => ({ line }))
              });
            }
            void request("configurationDone");
            break;
          }
          case "stopped": {
            const threadId = (message.body?.threadId as number | undefined) ?? null;
            setStatus("stopped");
            setStoppedThreadId(threadId);
            setDetail((message.body?.reason as string | undefined) ?? "stopped");
            if (threadId !== null) {
              void refreshStack(threadId);
            }
            break;
          }
          case "continued": {
            setStatus("running");
            setStoppedThreadId(null);
            setCallStack([]);
            break;
          }
          case "output": {
            const text = message.body?.output as string | undefined;
            if (typeof text === "string") {
              onOutputRef.current(text);
            }
            break;
          }
          case "terminated":
          case "exited": {
            setStatus("terminated");
            setStoppedThreadId(null);
            setCallStack([]);
            break;
          }
          default:
            break;
        }
      }
    });
    return unsubscribe;
  }, [client, request, refreshStack]);

  const start = useCallback(
    (root: string, adapterId: string, configId: string) => {
      if (pendingOpenIdRef.current !== null || sessionIdRef.current !== null) {
        return;
      }
      const openId = nextOpenId();
      pendingOpenIdRef.current = openId;
      setStatus("starting");
      setDetail(null);
      client.openDapSession(root, adapterId, configId, openId).catch((error: unknown) => {
        pendingOpenIdRef.current = null;
        const code = (error as { code?: string }).code ?? "";
        const messageText =
          (error as { message?: string }).message ?? String(error);
        setStatus(code === "dap_denied" || code.startsWith("dap_adapter") ? "denied" : "error");
        setDetail(messageText);
      });
    },
    [client]
  );

  const setBreakpoints = useCallback(
    (path: string, lines: number[]) => {
      breakpointsRef.current.set(path, lines);
      // If the session is already live, push them now; otherwise they replay on `initialized`.
      if (sessionIdRef.current !== null) {
        void request("setBreakpoints", {
          source: { path },
          breakpoints: lines.map((line) => ({ line }))
        });
      }
    },
    [request]
  );

  const resume = useCallback(
    (command: string) => {
      const threadId = stoppedThreadId ?? 1;
      void request(command, { threadId });
    },
    [request, stoppedThreadId]
  );

  const variables = useCallback(
    async (variablesReference: number): Promise<DapVariable[]> => {
      const response = await request("variables", { variablesReference });
      return (response.body?.variables as DapVariable[] | undefined) ?? [];
    },
    [request]
  );

  const evaluate = useCallback(
    async (expression: string): Promise<string> => {
      const frameId = callStack[0]?.id;
      const response = await request("evaluate", {
        expression,
        frameId,
        context: "repl"
      });
      if (response.success === false) {
        throw new Error(response.message ?? "evaluate failed");
      }
      return (response.body?.result as string | undefined) ?? "";
    },
    [request, callStack]
  );

  const stop = useCallback(() => {
    const id = sessionIdRef.current;
    if (id !== null) {
      void client.stopDap(id).catch(() => {
        // Idempotent stop; a rejection means it was already gone.
      });
    }
  }, [client]);

  return useMemo(
    () => ({
      status,
      sessionId,
      detail,
      stoppedThreadId,
      callStack,
      start,
      setBreakpoints,
      continue: () => resume("continue"),
      stepOver: () => resume("next"),
      stepIn: () => resume("stepIn"),
      stepOut: () => resume("stepOut"),
      variables,
      evaluate,
      stop
    }),
    [
      status,
      sessionId,
      detail,
      stoppedThreadId,
      callStack,
      start,
      setBreakpoints,
      resume,
      variables,
      evaluate,
      stop
    ]
  );
}
