import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AgentBackend,
  BackendCapability,
  DispatchMessage,
  StartRunRequest
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";

export interface ChatDockProps {
  client: WireClient;
  /** Hidden on the full Chat tab (no point doubling it there); stays mounted so the
      conversation survives tab switches. */
  hidden: boolean;
  /** Enabled providers; the dock chats under the first one. */
  availableBackends: AgentBackend[];
  /** Allowlisted roots; the dock runs under the first (a launch needs an allowed root). */
  workspaceRoots: string[];
  /** Detected catalog, for the default model of the chosen backend. */
  catalog: BackendCapability[];
}

interface Turn {
  id: string;
  role: "user" | "agent";
  body: string;
}

const SESSION_ID = "dock-session";

/**
 * A floating popup chat (the "site chat bubble", but it's your AI). Docked bottom-right on
 * every screen except the full Chat tab, so you can keep a conversation going while you browse
 * Work / Observe / Plan / etc. It reuses the same run seam as the Chat screen (`WireClient.start`
 * + the `message` event stream) and threads follow-ups so the conversation has continuity. It
 * lives in `App` (not a route), so switching tabs never resets it.
 */
export function ChatDock({
  client,
  hidden,
  availableBackends,
  workspaceRoots,
  catalog
}: Readonly<ChatDockProps>): ReactElement {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const lastRunIdRef = useRef<string | undefined>(undefined);

  const backend = availableBackends[0];
  const model = catalog.find((entry) => entry.backend === backend)?.defaultModel;
  const workspaceRoot = workspaceRoots[0] ?? "";

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (runIdRef.current === undefined || event.runId !== runIdRef.current) {
        return;
      }
      const payload = event.payload;
      if (payload.kind === "message" && payload.message.role === "agent") {
        if (payload.message.isPartial === true) {
          setStreaming((prev) => prev + payload.message.body);
        } else {
          const body = payload.message.body;
          setStreaming("");
          setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "agent", body }]);
          setBusy(false);
        }
      }
    });
    return unsubscribe;
  }, [client]);

  const send = (): void => {
    const text = input.trim();
    // Guard on `busy` too: a run is in flight, and starting a second would overwrite
    // runIdRef and silently drop the first run's streamed reply (the Send button is
    // disabled while busy, but Enter is not).
    if (text.length === 0 || backend === undefined || busy) {
      return;
    }
    const priorTurns = turns;
    const priorRunId = lastRunIdRef.current;
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role: "user", body: text }]);
    setInput("");
    setStreaming("");
    setBusy(true);

    const newRunId = crypto.randomUUID();
    runIdRef.current = newRunId;
    const now = new Date().toISOString();
    const request: StartRunRequest = {
      session: {
        id: SESSION_ID,
        backend,
        title: text,
        workspaceRoot,
        createdAt: now,
        updatedAt: now
      },
      workspaceRoot,
      task: text,
      requestedRunId: newRunId
    };
    if (model !== undefined) {
      request.model = model;
    }
    // Thread continuity: hand the prior turns + the previous run id as a follow-up so the
    // agent has the conversation so far.
    if (priorRunId !== undefined) {
      request.followUpToRunId = priorRunId;
      request.transcript = priorTurns.map((turn, index) =>
        transcriptMessage(turn, index, now, priorRunId)
      );
    }
    lastRunIdRef.current = newRunId;

    client.start(request).catch(() => {
      setBusy(false);
      setTurns((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "agent", body: "(couldn't reach the agent)" }
      ]);
    });
  };

  return (
    <div className={`chat-dock ${hidden ? "is-hidden" : ""}`} aria-hidden={hidden}>
      {open && (
        <div className="chat-dock-panel" role="dialog" aria-label="Quick chat">
          <div className="chat-dock-head">
            <span className="chat-dock-title">Quick chat</span>
            <button
              type="button"
              className="link-button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              Close
            </button>
          </div>
          <div className="chat-dock-log">
            {turns.length === 0 && streaming === "" && (
              <p className="chat-dock-empty">
                {backend === undefined
                  ? "Enable a provider in Settings to chat."
                  : "Ask anything. This chat follows you across tabs."}
              </p>
            )}
            {turns.map((turn) => (
              <div key={turn.id} className={`chat-dock-turn role-${turn.role}`}>
                {turn.body}
              </div>
            ))}
            {streaming !== "" && <div className="chat-dock-turn role-agent is-streaming">{streaming}</div>}
          </div>
          <div className="chat-dock-compose">
            <input
              type="text"
              aria-label="Chat message"
              value={input}
              disabled={backend === undefined}
              placeholder={backend === undefined ? "No provider enabled" : "Message…"}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  send();
                }
              }}
            />
            <button type="button" onClick={send} disabled={busy || backend === undefined}>
              {busy ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="chat-dock-bubble"
        aria-label={open ? "Close chat" : "Open chat"}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconChatBubble />
      </button>
    </div>
  );
}

/** Synthesize a transcript message from a display turn, for follow-up continuity. Ids are
    scoped to the originating (prior) run so they stay unique across sends rather than
    colliding on a per-send 0..n index. */
function transcriptMessage(
  turn: Turn,
  index: number,
  createdAt: string,
  priorRunId: string
): DispatchMessage {
  return {
    id: `dock-msg-${priorRunId}-${index}`,
    sessionId: SESSION_ID,
    runId: priorRunId,
    role: turn.role,
    body: turn.body,
    createdAt
  };
}

function IconChatBubble(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" strokeLinejoin="round" />
    </svg>
  );
}
