import { useCallback, useEffect, useRef, useState } from "react";
import type { WireClient } from "../../wire/client";
import { useDapSession, type DapStatus } from "./useDapSession";

// The integrated debugger surface (ADR-0106 Slice B). Desktop-local-only (the bridge refuses a
// relay session, D5) and an honest capability (it degrades to "Run is still available" when no
// adapter is installed, D8). This MVP drives the debug loop over `useDapSession`: pick a workspace
// root and a detected debug configuration, start under `netcoredbg`, then continue / step / inspect
// the call stack and stop. The Monaco breakpoint gutter, current-line decoration, and the
// variables / watch panels are layered on next.

interface DebugViewProps {
  client: WireClient;
  active: boolean;
  workspaceRoots: string[];
  defaultWorkspaceRoot?: string;
}

/** A human-readable status line for the debug panel. */
export function statusLabel(status: DapStatus): string {
  switch (status) {
    case "idle":
      return "Not debugging.";
    case "starting":
      return "Starting the debug session...";
    case "running":
      return "Running.";
    case "stopped":
      return "Stopped.";
    case "terminated":
      return "Debug session ended.";
    case "denied":
      return "Debug unavailable; Run is still available.";
    case "error":
      return "Debug error.";
    default:
      return status;
  }
}

/** Whether the debuggee is live (running or stopped), so the step / stop controls are shown. */
function isLive(status: DapStatus): boolean {
  return status === "running" || status === "stopped" || status === "starting";
}

export function DebugView({
  client,
  active,
  workspaceRoots,
  defaultWorkspaceRoot
}: DebugViewProps) {
  const [root, setRoot] = useState<string>(defaultWorkspaceRoot ?? workspaceRoots[0] ?? "");
  const [configId, setConfigId] = useState<string>("dotnet:run");
  const [output, setOutput] = useState<string>("");

  // Keep the selected root valid as the allowlist changes (a removed root falls back to the first).
  useEffect(() => {
    if (root === "" || !workspaceRoots.includes(root)) {
      setRoot(defaultWorkspaceRoot ?? workspaceRoots[0] ?? "");
    }
  }, [workspaceRoots, defaultWorkspaceRoot, root]);

  const appendOutput = useCallback((text: string) => {
    setOutput((previous) => previous + text);
  }, []);

  const session = useDapSession(client, appendOutput);

  // Scroll the console to the latest output.
  const consoleRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const node = consoleRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [output]);

  if (!active) {
    return null;
  }

  const canStart = root !== "" && configId.trim() !== "" && !isLive(session.status);
  const stopped = session.status === "stopped";

  return (
    <section className="debug-view" aria-label="Debugger">
      <header className="debug-view__head">
        <h2>Debug</h2>
        <span className="debug-view__status">{statusLabel(session.status)}</span>
      </header>

      <div className="debug-view__controls">
        <label className="debug-view__field">
          <span>Root</span>
          <select
            value={root}
            disabled={isLive(session.status)}
            onChange={(event) => setRoot(event.target.value)}
          >
            {workspaceRoots.length === 0 && <option value="">No allowlisted roots</option>}
            {workspaceRoots.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <label className="debug-view__field">
          <span>Configuration</span>
          <input
            value={configId}
            disabled={isLive(session.status)}
            onChange={(event) => setConfigId(event.target.value)}
            aria-label="Debug configuration id"
          />
        </label>
        {!isLive(session.status) ? (
          <button
            type="button"
            className="debug-view__button"
            disabled={!canStart}
            onClick={() => {
              setOutput("");
              session.start(root, "netcoredbg", configId.trim());
            }}
          >
            Debug
          </button>
        ) : (
          <>
            <button
              type="button"
              className="debug-view__button"
              disabled={!stopped}
              onClick={() => session.continue()}
            >
              Continue
            </button>
            <button
              type="button"
              className="debug-view__button"
              disabled={!stopped}
              onClick={() => session.stepOver()}
            >
              Step Over
            </button>
            <button
              type="button"
              className="debug-view__button"
              disabled={!stopped}
              onClick={() => session.stepIn()}
            >
              Step In
            </button>
            <button
              type="button"
              className="debug-view__button"
              disabled={!stopped}
              onClick={() => session.stepOut()}
            >
              Step Out
            </button>
            <button
              type="button"
              className="debug-view__button debug-view__button--stop"
              onClick={() => session.stop()}
            >
              Stop
            </button>
          </>
        )}
      </div>

      {session.detail !== null && (session.status === "denied" || session.status === "error") && (
        <p className="debug-view__detail" role="status">
          {session.detail}
        </p>
      )}

      <div className="debug-view__body">
        <div className="debug-view__stack" aria-label="Call stack">
          <h3>Call stack</h3>
          {session.callStack.length === 0 ? (
            <p className="debug-view__empty">
              {stopped ? "No frames." : "The call stack appears when the debuggee stops."}
            </p>
          ) : (
            <ol className="debug-view__frames">
              {session.callStack.map((frame) => (
                <li key={frame.id} className="debug-view__frame">
                  <span className="debug-view__frame-name">{frame.name}</span>
                  {frame.source !== undefined && (
                    <span className="debug-view__frame-loc">
                      {frame.source}:{frame.line}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <pre ref={consoleRef} className="debug-view__console" aria-label="Debug console">
          {output}
        </pre>
      </div>
    </section>
  );
}
