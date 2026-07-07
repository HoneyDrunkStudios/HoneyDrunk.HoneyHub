import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaunchTarget } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { useLaunchSession, type LaunchStatus } from "./useLaunchSession";

// The project-launch page (ADR-0104): pick an allowlisted workspace root, let the host detect
// its launch targets, and run one with its logs streamed here. Launch is mobile-safe: a phone
// over the relay may start one, so a relay session confirms each launch (naming the target)
// before it runs. The host owns which targets exist; the cockpit only sends a detected id back.

/** Cap on retained log characters, a bounded scrollback (ADR-0104 D2). */
const LOG_MAX_CHARS = 200_000;

/** True when the cockpit was loaded over the relay rather than on the machine running the
    bridge. The host classifies the same connection by peer address; this is the client-side
    mirror that drives the per-launch relay confirmation (ADR-0104 D3). */
function isRelayConnection(): boolean {
  // Strip the brackets an IPv6 URL host carries (e.g. "[::1]"), then treat localhost and the whole
  // 127.0.0.0/8 loopback range as local, matching the host's `is_loopback()` classification.
  const host = (globalThis.location?.hostname ?? "").replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || host === "" || /^127\./.test(host));
}

/** ANSI CSI escape sequence: ESC (0x1b) then [, params, and a final letter. Built via
    fromCharCode so the source carries no invisible control-character literal (which reads as
    a missing ESC anchor in diffs and would strip legitimate bracketed text like [vite]). */
const ANSI_CSI = new RegExp(String.fromCharCode(27) + "\[[0-9;?]*[A-Za-z]", "g");

/** Strip the common ANSI CSI escape sequences so a colored dev-server log reads as plain text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

interface LaunchViewProps {
  client: WireClient;
  active: boolean;
  workspaceRoots: string[];
  defaultWorkspaceRoot?: string;
}

export function statusLabel(status: LaunchStatus, detail: string | null): string {
  switch (status) {
    case "idle":
      return "No launch running.";
    case "starting":
      return "Starting...";
    case "running":
      return "Running.";
    case "stopped":
      return `Stopped${detail ? ` (${detail})` : ""}.`;
    case "denied":
      return `The host did not offer that target${detail ? `: ${detail}` : ""}.`;
    case "error":
      return `Could not start the launch${detail ? `: ${detail}` : ""}.`;
    default:
      return "";
  }
}

export function kindBadge(kind: LaunchTarget["kind"]): string {
  switch (kind) {
    case "run":
      return "Run";
    case "build":
      return "Build";
    case "test":
      return "Test";
    default:
      return "Script";
  }
}

export function LaunchView({
  client,
  active,
  workspaceRoots,
  defaultWorkspaceRoot
}: LaunchViewProps) {
  const roots = useMemo(
    () => workspaceRoots.filter((root) => root.trim() !== ""),
    [workspaceRoots]
  );
  const [selectedRoot, setSelectedRoot] = useState<string>(
    () => defaultWorkspaceRoot ?? roots[0] ?? ""
  );
  const [targets, setTargets] = useState<LaunchTarget[]>([]);
  const [log, setLog] = useState<string>("");

  const appendOutput = useCallback((text: string) => {
    setLog((previous) => {
      const next = previous + stripAnsi(text);
      return next.length > LOG_MAX_CHARS ? next.slice(next.length - LOG_MAX_CHARS) : next;
    });
  }, []);
  const session = useLaunchSession(client, appendOutput);

  // Keep the selected root valid as the allowlist changes (a removed root falls back).
  useEffect(() => {
    if (selectedRoot !== "" && roots.includes(selectedRoot)) {
      return;
    }
    setSelectedRoot(defaultWorkspaceRoot ?? roots[0] ?? "");
  }, [roots, defaultWorkspaceRoot, selectedRoot]);

  // Detect the selected root's launch targets whenever it changes while the page is active.
  // Subscribe FIRST, then request detection, so a synchronous answer (the offline mock) is not
  // missed; the real host answers asynchronously either way.
  useEffect(() => {
    if (!active || selectedRoot === "") {
      return;
    }
    setTargets([]);
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "launch_targets" && event.payload.root === selectedRoot) {
        setTargets(event.payload.targets);
      }
    });
    void client.detectLaunchTargets(selectedRoot).catch(() => {
      // A denied/unavailable detection just leaves the target list empty.
    });
    return unsubscribe;
  }, [active, selectedRoot, client]);

  // Autoscroll the log to the newest output.
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const node = logRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [log]);

  // "Busy" (starting or running) disables the root switch and target buttons; "can stop" is only
  // true once a launch is actually adopted (a launch id exists), since stop() is a no-op before
  // that, so a Stop control shown during "starting" would silently do nothing.
  const isRunning = session.status === "running" || session.status === "starting";
  const canStop = session.launchId !== null;

  const onStart = useCallback(
    (target: LaunchTarget) => {
      // A relay session confirms each launch, naming the target, before it runs (ADR-0104 D3).
      if (isRelayConnection()) {
        const ok = globalThis.confirm?.(
          `Start "${target.label}" on the machine running the bridge, from this device?`
        );
        if (ok !== true) {
          return;
        }
      }
      setLog("");
      session.start(selectedRoot, target.id);
    },
    [session, selectedRoot]
  );

  if (!active) {
    return null;
  }

  if (roots.length === 0) {
    return (
      <section className="launch-view">
        <header className="launch-view__head">
          <h2>Launch</h2>
        </header>
        <p className="launch-view__empty">
          Add a workspace root in Settings to detect and run a project&apos;s launch targets.
        </p>
      </section>
    );
  }

  return (
    <section className="launch-view">
      <header className="launch-view__head">
        <h2>Launch</h2>
        <label className="launch-view__root">
          <span>Root</span>
          <select
            value={selectedRoot}
            disabled={isRunning}
            onChange={(event) => setSelectedRoot(event.target.value)}
          >
            {roots.map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
        </label>
      </header>

      <p className="launch-view__hint">
        The host detects these targets from the repository and runs the one you pick. A launch
        runs the project&apos;s own code with your account&apos;s access, and is tree-killed when
        you stop it or disconnect.
      </p>

      {targets.length === 0 ? (
        <p className="launch-view__empty">
          No launch targets detected here. Add a detector for this repo type, or use the terminal.
        </p>
      ) : (
        <ul className="launch-view__targets">
          {targets.map((target) => (
            <li key={target.id}>
              <button
                type="button"
                className="launch-view__target"
                disabled={isRunning}
                onClick={() => onStart(target)}
              >
                <span className={`launch-view__badge launch-view__badge--${target.kind}`}>
                  {kindBadge(target.kind)}
                </span>
                {target.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="launch-view__controls">
        <span className="launch-view__status" role="status">
          {statusLabel(session.status, session.detail)}
        </span>
        {canStop && (
          <button
            type="button"
            className="launch-view__stop"
            onClick={() => session.stop()}
          >
            Stop
          </button>
        )}
      </div>

      <pre className="launch-view__log" ref={logRef}>
        {log}
      </pre>
    </section>
  );
}
