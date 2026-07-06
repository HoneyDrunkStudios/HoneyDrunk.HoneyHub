import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { WireClient } from "../../wire/client";
import { utf8ToBase64 } from "../../terminal/base64";
import { useTerminalSession, type TerminalStatus } from "./useTerminalSession";

// The xterm.js half of the integrated terminal (ADR-0103): it renders the emulator and binds
// it to a `useTerminalSession`. Lazy-loaded (like CodeEditor) so xterm's canvas/CSS never
// loads for the mobile PWA or in jsdom tests, and coverage-excluded for the same reason the
// Monaco editor is (a live DOM/canvas boundary, not unit-testable). All the testable
// coordination lives in the hook.

interface TerminalPaneProps {
  client: WireClient;
  /** The allowlisted workspace root the shell opens in (host re-gates it). */
  root: string;
  /** Notified whenever the session's status changes, so the page can show it. */
  onStatus?: (status: TerminalStatus, detail: string | null) => void;
}

export default function TerminalPane({ client, root, onStatus }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Output sink: decode-to-bytes happens in the hook; here we just write to xterm.
  const onOutput = useCallback((bytes: Uint8Array) => {
    termRef.current?.write(bytes);
  }, []);
  const session = useTerminalSession(client, onOutput);

  // Surface status changes to the page (opening / open / closed / denied / error). Skip the
  // hook's initial "idle": the page already set "opening" when it mounted this pane, so
  // reporting "idle" on mount would clobber that and flicker the toolbar back to a closed state.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    if (session.status !== "idle") {
      onStatusRef.current?.(session.status, session.detail);
    }
  }, [session.status, session.detail]);

  // Mount xterm once, wire input + resize, and open the session. `root`/`client` identify the
  // pane; a new root remounts the component (keyed by root in the page), so this runs per root.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: { background: "#0b0e14" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    // Operator keystrokes -> the shell's stdin (base64 of the UTF-8 bytes xterm delivers).
    const dataSub = term.onData((data) => {
      session.sendInput(utf8ToBase64(data));
    });

    // Open the shell at the fitted size.
    session.open(root, term.cols, term.rows);

    // Reflow on container resize, telling the host so the PTY matches (best-effort).
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        session.resize(term.cols, term.rows);
      } catch {
        // A fit during teardown can throw once; ignore.
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      session.close();
      term.dispose();
      termRef.current = null;
    };
    // Intentionally mount-once per (client, root): `session` methods are stable (memoized on
    // the client), so they need not re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, root]);

  return <div className="terminal-pane" ref={containerRef} />;
}
