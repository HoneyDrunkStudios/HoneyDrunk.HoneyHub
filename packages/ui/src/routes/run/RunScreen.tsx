import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DispatchArtifact,
  DispatchMessage,
  DispatchRunState,
  StartRunRequest,
  UsageSignal
} from "@honeydrunk/honeyhub-types";
import { UsageBadge } from "../../components/UsageBadge";
import type { WireClient } from "../../wire/client";

export interface RunScreenProps {
  client: WireClient;
  /** Allowlisted workspace roots (packet 05). When empty, a free-text root is
      accepted and the bridge enforces the allowlist on launch. */
  workspaceRoots?: string[];
}

const TERMINAL: DispatchRunState[] = ["completed", "failed", "cancelled"];

function isTerminal(state: DispatchRunState | undefined): boolean {
  return state !== undefined && TERMINAL.includes(state);
}

export function RunScreen({ client, workspaceRoots = [] }: RunScreenProps) {
  const [task, setTask] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState(workspaceRoots[0] ?? "");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [runState, setRunState] = useState<DispatchRunState | undefined>(undefined);
  const [messages, setMessages] = useState<DispatchMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [artifacts, setArtifacts] = useState<DispatchArtifact[]>([]);
  const [usage, setUsage] = useState<UsageSignal[]>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  // Keep the active run id available to the event handler without re-subscribing.
  const runIdRef = useRef<string | undefined>(undefined);
  runIdRef.current = runId;

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (runIdRef.current !== undefined && event.runId !== runIdRef.current) {
        return;
      }
      const payload = event.payload;
      switch (payload.kind) {
        case "message":
          if (payload.message.isPartial === true) {
            setStreaming((prev) => prev + payload.message.body);
          } else {
            setStreaming("");
            setMessages((prev) => [...prev, payload.message]);
          }
          break;
        case "status":
          setRunState(payload.status.state);
          break;
        case "usage":
          setUsage((prev) => [...prev, payload.signal]);
          break;
        case "artifact":
          setArtifacts((prev) => [...prev, payload.artifact]);
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [client]);

  const active = runId !== undefined && !isTerminal(runState);

  const onStart = async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setError("Enter a task to start a run.");
      return;
    }
    setError(undefined);
    setMessages([
      {
        id: "user-0",
        sessionId: "session-1",
        runId: "pending",
        role: "user",
        body: trimmed,
        createdAt: new Date().toISOString()
      }
    ]);
    setArtifacts([]);
    setUsage([]);
    setStreaming("");

    const request: StartRunRequest = {
      session: {
        id: "session-1",
        backend: "claude.local",
        title: trimmed,
        workspaceRoot,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      workspaceRoot,
      task: trimmed
    };
    try {
      const started = await client.start(request);
      setRunId(started.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to start run");
    }
  };

  const onSend = async () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || runId === undefined) {
      return;
    }
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${prev.length}`,
        sessionId: "session-1",
        runId,
        role: "user",
        body: trimmed,
        createdAt: new Date().toISOString()
      }
    ]);
    setReply("");
    try {
      await client.reply(runId, trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to send");
    }
  };

  const onStop = async () => {
    if (runId === undefined) {
      return;
    }
    try {
      await client.stop(runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to stop");
    }
  };

  const latestUsage = useMemo(() => usage[usage.length - 1], [usage]);
  const needsInput = runState === "needs_input";
  const canFollowUp = isTerminal(runState);

  return (
    <section className="run-screen" aria-label="Run">
      <header className="run-header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{runId === undefined ? "Start a session" : task}</h2>
        </div>
        <div className="run-status-group">
          {runState !== undefined && (
            <span className="status-pill" aria-label="Run state">
              {runState}
            </span>
          )}
          {latestUsage !== undefined && <UsageBadge usage={latestUsage} />}
        </div>
      </header>

      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}

      {runId === undefined ? (
        <div className="run-start" >
          <label htmlFor="workspace-root">Workspace root</label>
          {workspaceRoots.length > 0 ? (
            <select
              id="workspace-root"
              value={workspaceRoot}
              onChange={(event) => setWorkspaceRoot(event.target.value)}
            >
              {workspaceRoots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="workspace-root"
              value={workspaceRoot}
              onChange={(event) => setWorkspaceRoot(event.target.value)}
              placeholder="/path/to/allowlisted/workspace"
            />
          )}
          <span className="run-backend">Backend: claude.local</span>
          <label htmlFor="task">Task</label>
          <textarea
            id="task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={3}
          />
          <button type="button" onClick={onStart}>
            Start session
          </button>
        </div>
      ) : (
        <>
          <ol className="transcript" aria-label="Transcript">
            {messages.map((message) => (
              <li key={message.id} className={`message role-${message.role}`}>
                <span className="message-role">{message.role}</span>
                <span className="message-body">{message.body}</span>
              </li>
            ))}
            {streaming.length > 0 && (
              <li className="message role-agent streaming" aria-label="Streaming">
                <span className="message-role">agent</span>
                <span className="message-body">{streaming}</span>
              </li>
            )}
          </ol>

          {artifacts.length > 0 && (
            <ul className="artifacts" aria-label="Artifacts">
              {artifacts.map((artifact) => (
                <li key={artifact.id} className={`artifact kind-${artifact.kind}`}>
                  <span className="artifact-kind">{artifact.kind}</span>
                  {artifact.href !== undefined ? (
                    <a href={artifact.href} target="_blank" rel="noreferrer">
                      {artifact.label}
                    </a>
                  ) : (
                    <span>{artifact.label}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="run-controls">
            {(needsInput || canFollowUp) && (
              <div className="reply-box">
                <label htmlFor="reply">
                  {needsInput ? "Reply" : "Follow up"}
                </label>
                <input
                  id="reply"
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                />
                <button type="button" onClick={onSend}>
                  Send
                </button>
              </div>
            )}
            {active && (
              <button type="button" className="stop" onClick={onStop}>
                Stop
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
