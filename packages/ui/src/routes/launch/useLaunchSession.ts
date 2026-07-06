import { useCallback, useEffect, useRef, useState } from "react";
import type { WireClient } from "../../wire/client";
import { base64ToBytes } from "../../wire/base64";

// The wire-coordination half of project launch (ADR-0104). It owns one launch's lifecycle over
// the WireClient seam: start a detected target, route its output to a callback, and stop it.
// Launch output is line-oriented program stdout/stderr, so (unlike the terminal) the view can
// render it in a plain scrolling log with no xterm, and this hook is fully unit-testable.

export type LaunchStatus = "idle" | "starting" | "running" | "stopped" | "error" | "denied";

export interface LaunchSession {
  /** The launch's lifecycle state, for the panel's status line. */
  status: LaunchStatus;
  /** The host-assigned launch id once running (null before / after). */
  launchId: string | null;
  /** A short opaque code for a stop (`exited` / `stopped` / `disconnected` / `root_removed`) or
      the message for a denial / error. */
  detail: string | null;
  /** Start the detected `targetId` in `root`. An unknown/unoffered id is denied by the host. */
  start: (root: string, targetId: string) => void;
  /** Stop the running launch (tree-kills the process group). Idempotent. */
  stop: () => void;
}

/** Monotonic fallback for correlation nonces when Web Crypto's randomUUID is unavailable. */
let launchCounter = 0;

/** A correlation nonce for one start request, echoed by the host on `launch_started` so this
    hook adopts the launch that answers ITS request (the event is broadcast device-wide). It must
    be unique ACROSS cockpits, which matters for launch because it is mobile-safe: over a plain-
    http relay `crypto.randomUUID` is unavailable (it needs a secure context), so fall back to
    `crypto.getRandomValues` (which works in insecure contexts) before the last-resort counter. */
function nextOpenId(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  launchCounter += 1;
  return `launch-${launchCounter}`;
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
 * Manage a single launch over `client`. Output chunks are decoded to text and handed to
 * `onOutput` (the panel appends them to its log). The handler is held in a ref so the event
 * subscription is installed once.
 */
export function useLaunchSession(
  client: WireClient,
  onOutput: (text: string) => void
): LaunchSession {
  const [status, setStatus] = useState<LaunchStatus>("idle");
  const [launchId, setLaunchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  // A streaming decoder held across chunks: the host reads output in fixed-size byte chunks, so a
  // multibyte UTF-8 char can straddle a chunk boundary. `decode(bytes, { stream: true })` retains
  // the partial bytes until the next chunk completes them, instead of emitting replacement chars.
  const decoderRef = useRef<TextDecoder | null>(null);

  const launchIdRef = useRef<string | null>(null);
  // The correlation nonce of the in-flight start, so we adopt the `launch_started` that answers
  // OUR request (the event is broadcast to every cockpit). Cleared once adopted or on failure.
  const pendingOpenIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "launch_started") {
        if (
          pendingOpenIdRef.current !== null &&
          payload.openId === pendingOpenIdRef.current &&
          launchIdRef.current === null
        ) {
          pendingOpenIdRef.current = null;
          launchIdRef.current = payload.launchId;
          setLaunchId(payload.launchId);
          setStatus("running");
        }
        return;
      }
      if (payload.kind === "launch_output") {
        if (payload.launchId === launchIdRef.current) {
          const decoder = decoderRef.current ?? new TextDecoder();
          decoderRef.current = decoder;
          onOutputRef.current(decoder.decode(base64ToBytes(payload.data), { stream: true }));
        }
        return;
      }
      if (payload.kind === "launch_stopped") {
        if (payload.launchId === launchIdRef.current) {
          launchIdRef.current = null;
          setLaunchId(null);
          setStatus("stopped");
          setDetail(payload.reason);
        }
      }
    });
    return unsubscribe;
  }, [client]);

  const start = useCallback(
    (root: string, targetId: string) => {
      // Guard against a double-start (a second click while one is in flight or running).
      if (pendingOpenIdRef.current !== null || launchIdRef.current !== null) {
        return;
      }
      const openId = nextOpenId();
      pendingOpenIdRef.current = openId;
      decoderRef.current = new TextDecoder();
      setStatus("starting");
      setDetail(null);
      client.startLaunch(root, targetId, openId).catch((error: unknown) => {
        pendingOpenIdRef.current = null;
        const { code, message } = errorParts(error);
        setStatus(code === "launch_denied" ? "denied" : "error");
        setDetail(message);
      });
    },
    [client]
  );

  const stop = useCallback(() => {
    const id = launchIdRef.current;
    if (id !== null) {
      client.stopLaunch(id).catch(() => {
        // Idempotent stop; a rejection means it was already gone.
      });
    }
  }, [client]);

  return { status, launchId, detail, start, stop };
}
