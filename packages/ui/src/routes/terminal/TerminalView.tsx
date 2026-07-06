import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { WireClient } from "../../wire/client";
import type { TerminalStatus } from "./useTerminalSession";

// The integrated-terminal page (ADR-0103): pick an allowlisted workspace root and open a
// real, PTY-backed shell in it. The terminal is desktop-local-only. On a phone reaching the
// bridge over the relay, the host refuses with `terminal_denied`, surfaced here as a clear
// note instead of a dead pane. Opening a terminal is itself the operator's confirmation:
// the shell runs with the operator's own OS reach (the allowlist gates where it OPENS, and
// does not sandbox what it can then touch), so the button says so plainly.

// xterm is heavy (canvas + CSS) and useless on a phone, so load the pane lazily so the mobile
// PWA and jsdom tests never pull it in.
const TerminalPane = lazy(() => import("./TerminalPane"));

interface TerminalViewProps {
  client: WireClient;
  active: boolean;
  /** The operator's allowlisted workspace roots (from Bridge settings). */
  workspaceRoots: string[];
  /** The preferred root, if the operator set one. */
  defaultWorkspaceRoot?: string;
}

function statusLabel(status: TerminalStatus, detail: string | null): string {
  switch (status) {
    case "idle":
      return "No terminal open.";
    case "opening":
      return "Opening a shell…";
    case "open":
      return "Shell running.";
    case "closed":
      return `Shell closed${detail ? ` (${detail})` : ""}.`;
    case "denied":
      return "The integrated terminal is desktop-local-only. Open it on the machine running the bridge; the relay cannot reach it.";
    case "error":
      return `Could not open a terminal${detail ? `: ${detail}` : ""}.`;
    default:
      return "";
  }
}

export function TerminalView({
  client,
  active,
  workspaceRoots,
  defaultWorkspaceRoot
}: TerminalViewProps) {
  const roots = useMemo(() => workspaceRoots.filter((root) => root.trim() !== ""), [workspaceRoots]);
  const [selectedRoot, setSelectedRoot] = useState<string>(
    () => defaultWorkspaceRoot ?? roots[0] ?? ""
  );
  // A fresh id per "Open terminal" click, keyed onto the pane so re-opening after a close
  // remounts a clean pane rather than reconciling onto the stale instance. It passes through
  // null between opens (fully unmounting the pane), so reusing the value 1 is safe.
  const [openId, setOpenId] = useState<number | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  // Keep the selected root valid as the allowlist changes (a removed root falls back).
  useEffect(() => {
    if (selectedRoot !== "" && roots.includes(selectedRoot)) {
      return;
    }
    setSelectedRoot(defaultWorkspaceRoot ?? roots[0] ?? "");
  }, [roots, defaultWorkspaceRoot, selectedRoot]);

  const isOpen = openId !== null && (status === "open" || status === "opening");

  if (!active) {
    return null;
  }

  if (roots.length === 0) {
    return (
      <section className="terminal-view">
        <header className="terminal-view__head">
          <h2>Terminal</h2>
        </header>
        <p className="terminal-view__empty">
          Add a workspace root in Settings to open a terminal in one of your repos.
        </p>
      </section>
    );
  }

  return (
    <section className="terminal-view">
      <header className="terminal-view__head">
        <h2>Terminal</h2>
        <div className="terminal-view__controls">
          <label className="terminal-view__root">
            <span>Root</span>
            <select
              value={selectedRoot}
              disabled={isOpen}
              onChange={(event) => setSelectedRoot(event.target.value)}
            >
              {roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          </label>
          {isOpen ? (
            <button
              type="button"
              className="terminal-view__button terminal-view__button--stop"
              onClick={() => {
                // Unmounting the pane runs its cleanup, which tree-kills the shell; reset the
                // status line to idle so it doesn't linger on "Shell running".
                setOpenId(null);
                setStatus("idle");
                setDetail(null);
              }}
            >
              Close terminal
            </button>
          ) : (
            <button
              type="button"
              className="terminal-view__button"
              disabled={selectedRoot === ""}
              onClick={() => {
                setStatus("opening");
                setDetail(null);
                setOpenId((previous) => (previous ?? 0) + 1);
              }}
            >
              Open terminal
            </button>
          )}
        </div>
      </header>

      <p className="terminal-view__hint">
        A terminal runs a real shell with your own account&apos;s access. The workspace root
        sets where it opens; it does not sandbox what the shell can then reach. It stays on this
        machine and is tree-killed when you close it or disconnect.
      </p>

      <p className="terminal-view__status" role="status">
        {statusLabel(status, detail)}
      </p>

      {openId !== null && selectedRoot !== "" && (
        <Suspense fallback={<div className="terminal-pane terminal-pane--loading">Loading terminal…</div>}>
          <TerminalPane
            key={`${openId}:${selectedRoot}`}
            client={client}
            root={selectedRoot}
            onStatus={(next, nextDetail) => {
              setStatus(next);
              setDetail(nextDetail);
              // A host-side close (exit / disconnect / idle / root removed) retires the pane.
              if (next === "closed" || next === "denied" || next === "error") {
                setOpenId(null);
              }
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
