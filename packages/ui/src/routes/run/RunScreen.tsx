import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBackend,
  DispatchArtifact,
  DispatchMessage,
  DispatchRunState,
  StartRunRequest,
  UsageSignal
} from "@honeydrunk/honeyhub-types";
import { UsageBadge } from "../../components/UsageBadge";
import { backendLabel } from "../../backends";
import { recommendBackend } from "../routing/router";
import { BUNDLED_SNAPSHOT } from "../routing/routingSnapshot";
import { SessionDiagnostics } from "./SessionDiagnostics";
import type { WireClient } from "../../wire/client";

// The backends the cockpit can offer; the bridge enforces the real backend allowlist
// on launch, and the router ranks among these.
const ROUTABLE_BACKENDS: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];

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
  const [backend, setBackend] = useState<AgentBackend>("claude.local");
  // Once the user picks a backend by hand, stop following the router's suggestion.
  const [backendPinned, setBackendPinned] = useState(false);

  // The router's suggestion for the current task (app-tier, ADR-0092 D3). Recomputed
  // as the task text changes; a pure function of the task + the bundled snapshot.
  const recommendation = useMemo(
    () => recommendBackend({ task, availableBackends: ROUTABLE_BACKENDS }, BUNDLED_SNAPSHOT),
    [task]
  );
  // Follow the suggestion until the user overrides it.
  useEffect(() => {
    if (!backendPinned) {
      setBackend(recommendation.backend);
    }
  }, [recommendation.backend, backendPinned]);

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

  const userMessage = (id: string, forRunId: string, body: string): DispatchMessage => ({
    id,
    sessionId: "session-1",
    runId: forRunId,
    role: "user",
    body,
    createdAt: new Date().toISOString()
  });

  // Begin a run under a client-preallocated id. Binding `runIdRef` (and the
  // request's `requestedRunId`) before `start` means the event handler filters to
  // this run from the first event, rather than briefly accepting all events.
  const beginRun = async (
    taskText: string,
    options?: { followUpToRunId?: string; transcript?: DispatchMessage[] }
  ): Promise<string> => {
    const newRunId = crypto.randomUUID();
    runIdRef.current = newRunId;
    setRunId(newRunId);
    setRunState(undefined);
    setStreaming("");

    const request: StartRunRequest = {
      session: {
        id: "session-1",
        backend,
        title: taskText,
        workspaceRoot,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      workspaceRoot,
      task: taskText,
      requestedRunId: newRunId
    };
    // Set the optional follow-up fields only when present (exactOptionalPropertyTypes).
    if (options?.followUpToRunId !== undefined) {
      request.followUpToRunId = options.followUpToRunId;
    }
    if (options?.transcript !== undefined) {
      request.transcript = options.transcript;
    }
    await client.start(request);
    return newRunId;
  };

  const onStart = async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setError("Enter a task to start a run.");
      return;
    }
    if (workspaceRoot.trim().length === 0) {
      setError("Pick a workspace root to start a run.");
      return;
    }
    setError(undefined);
    setArtifacts([]);
    setUsage([]);
    try {
      const newRunId = await beginRun(trimmed);
      setMessages([userMessage("user-0", newRunId, trimmed)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to start run");
    }
  };

  const onSend = async () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || runId === undefined) {
      return;
    }
    setReply("");
    try {
      if (needsInput) {
        // Live, same-process reply into the active run.
        setMessages((prev) => [...prev, userMessage(`user-${prev.length}`, runId, trimmed)]);
        await client.reply(runId, trimmed);
      } else if (canFollowUp) {
        // A follow-up after completion is a NEW run carrying the prior transcript
        // (ADR-0090 D4 / StartRunRequest.followUpToRunId), not a reply into the
        // completed run.
        const priorTranscript = messages;
        const previousRunId = runId;
        const newRunId = await beginRun(trimmed, {
          followUpToRunId: previousRunId,
          transcript: priorTranscript
        });
        setMessages((prev) => [...prev, userMessage(`user-${prev.length}`, newRunId, trimmed)]);
      }
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
          <label htmlFor="task">Task</label>
          <textarea
            id="task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={3}
          />
          <label htmlFor="backend">Backend</label>
          <select
            id="backend"
            value={backend}
            onChange={(event) => {
              setBackend(event.target.value as AgentBackend);
              setBackendPinned(true);
            }}
          >
            {ROUTABLE_BACKENDS.map((option) => (
              <option key={option} value={option}>
                {backendLabel(option)}
                {option === recommendation.backend ? " (suggested)" : ""}
              </option>
            ))}
          </select>
          <p className="routing-rationale">
            {recommendation.rationale}
            {recommendation.snapshotSource === "bundled-default" && (
              <span className="routing-source"> · rates: bundled</span>
            )}
          </p>
          <button type="button" onClick={onStart}>
            Start session
          </button>
        </div>
      ) : (
        <>
          <SessionDiagnostics backend={backend} messages={messages} usage={usage} />

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
                    <a href={artifact.href} target="_blank" rel="noopener noreferrer">
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
