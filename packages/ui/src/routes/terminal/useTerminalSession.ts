import { useCallback, useEffect, useRef, useState } from "react";
import type { WireClient } from "../../wire/client";
import { base64ToBytes } from "../../terminal/base64";

// The wire-coordination half of the integrated terminal (ADR-0103), split from the xterm
// rendering (TerminalPane) so it is unit-testable without a canvas. It owns one session's
// lifecycle over the WireClient seam: open, route output to a callback, feed input, resize,
// and close. The pane is a thin view over this.

export type TerminalStatus =
  | "idle"
  | "opening"
  | "open"
  | "closed"
  | "denied"
  | "error";

export interface TerminalSession {
  /** The session's lifecycle state, for the pane's status line. */
  status: TerminalStatus;
  /** The host-assigned session id once open (null before / after). */
  sessionId: string | null;
  /** A short opaque code for a close (`exited` / `disconnected` / `idle_timeout` /
      `root_removed` / `closed`) or the message for a denial / error. */
  detail: string | null;
  /** Open a PTY-backed shell in `root`, sized `cols` x `rows`. A relay connection is refused
      by the host (`terminal_denied`), surfaced here as `status: "denied"`. */
  open: (root: string, cols: number, rows: number) => void;
  /** Feed keystrokes (`data`, base64 of the raw bytes) to the open session. */
  sendInput: (data: string) => void;
  /** Resize the open session's PTY. */
  resize: (cols: number, rows: number) => void;
  /** Close the open session (tree-kills the shell). Idempotent. */
  close: () => void;
}

/** Monotonic fallback for correlation nonces when Web Crypto's randomUUID is unavailable. */
let openCounter = 0;

/** A correlation nonce for one open request, echoed by the host on `terminal_opened` so this
    hook adopts the session that answers ITS request (the event is broadcast device-wide). */
function nextOpenId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  openCounter += 1;
  return `open-${openCounter}`;
}

/** The error shape a rejected wire command carries (a bridge `{ code, message }`). */
function errorParts(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : String(error);
    return { code, message };
  }
  return { code: "", message: String(error) };
}

/**
 * Manage a single terminal session over `client`. Output chunks are decoded to raw bytes and
 * handed to `onOutput` (the pane writes them to xterm). The handler is held in a ref so the
 * event subscription is installed once, not re-wired on every render.
 */
export function useTerminalSession(
  client: WireClient,
  onOutput: (bytes: Uint8Array) => void
): TerminalSession {
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  // Latest output sink, so the subscription (installed once) always calls the current handler.
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  // The session id we consider ours. A ref (not just state) so the event handler reads the
  // live value without being re-created. Terminal events are device-wide, so we match by id.
  const sessionIdRef = useRef<string | null>(null);
  // The correlation nonce of the in-flight open, so we adopt the `terminal_opened` that answers
  // OUR request (the event is broadcast to every cockpit, so a second cockpit opening at the
  // same time would otherwise be adopted here). Cleared once adopted or on failure.
  const pendingOpenIdRef = useRef<string | null>(null);
  // Set when `close()` is called while an open is still in flight (no session id yet). The shell
  // is being spawned host-side, so we cannot close it until we learn its id; on adoption we close
  // it immediately, so a pane that unmounts mid-open never leaks a live shell (ADR-0103 D5).
  const wantCloseRef = useRef(false);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "terminal_opened") {
        if (
          pendingOpenIdRef.current !== null &&
          payload.openId === pendingOpenIdRef.current &&
          sessionIdRef.current === null
        ) {
          pendingOpenIdRef.current = null;
          sessionIdRef.current = payload.sessionId;
          if (wantCloseRef.current) {
            // A close was requested before this open resolved (e.g. the pane unmounted). Close
            // the now-known session at once instead of leaving it running, and settle the status
            // so the hook does not stay stuck on "opening" if the component is still mounted.
            wantCloseRef.current = false;
            client.closeTerminal(payload.sessionId).catch(() => {});
            sessionIdRef.current = null;
            setStatus("closed");
            setDetail("closed");
            return;
          }
          setSessionId(payload.sessionId);
          setStatus("open");
        }
        return;
      }
      if (payload.kind === "terminal_output") {
        if (payload.sessionId === sessionIdRef.current) {
          onOutputRef.current(base64ToBytes(payload.data));
        }
        return;
      }
      if (payload.kind === "terminal_closed") {
        if (payload.sessionId === sessionIdRef.current) {
          sessionIdRef.current = null;
          setSessionId(null);
          setStatus("closed");
          setDetail(payload.reason);
        }
      }
    });
    return unsubscribe;
  }, [client]);

  const open = useCallback(
    (root: string, cols: number, rows: number) => {
      // Guard against a double-open (a second click while one is in flight or live).
      if (pendingOpenIdRef.current !== null || sessionIdRef.current !== null) {
        return;
      }
      const openId = nextOpenId();
      pendingOpenIdRef.current = openId;
      // Clear any stale pending-close from a prior aborted open, so it cannot tear down THIS one.
      wantCloseRef.current = false;
      setStatus("opening");
      setDetail(null);
      client.openTerminal(root, cols, rows, openId).catch((error: unknown) => {
        pendingOpenIdRef.current = null;
        const { code, message } = errorParts(error);
        setStatus(code === "terminal_denied" ? "denied" : "error");
        setDetail(message);
      });
    },
    [client]
  );

  const sendInput = useCallback(
    (data: string) => {
      const id = sessionIdRef.current;
      if (id !== null) {
        client.sendTerminalInput(id, data).catch(() => {
          // A write to a just-closed session races the `terminal_closed`; the event will set
          // the closed state, so swallow the transient rejection here.
        });
      }
    },
    [client]
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      const id = sessionIdRef.current;
      if (id !== null) {
        client.resizeTerminal(id, cols, rows).catch(() => {
          // Best-effort; a resize on a dead session is harmless.
        });
      }
    },
    [client]
  );

  const close = useCallback(() => {
    const id = sessionIdRef.current;
    if (id !== null) {
      client.closeTerminal(id).catch(() => {
        // Idempotent close; a rejection means it was already gone.
      });
      return;
    }
    // No session id yet: an open is still in flight. Remember the close so the session is torn
    // down the moment it is adopted, rather than leaking a shell whose id we never learned.
    if (pendingOpenIdRef.current !== null) {
      wantCloseRef.current = true;
    }
  }, [client]);

  return { status, sessionId, detail, open, sendInput, resize, close };
}
