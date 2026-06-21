import type { ReactElement } from "react";
import { RunScreen, type RunScreenProps } from "../run/RunScreen";

// The right-hand chat sidebar. It is the same full-featured chat as the dedicated Chat
// page (session history, model/provider picker, new chat, slash menu, agents, file +
// image attachments) — it just renders the RunScreen in a compact, single-column
// `sidebar` variant docked on the right of every page. It replaces the old floating
// chat dock so a conversation can ride along while you browse Work / Observe / Plan.
//
// It stays mounted even when collapsed (visibility is CSS-toggled), so the conversation
// survives both a collapse and a tab switch, exactly like the dock did.

/** The session id the sidebar's chat runs under — distinct from the full Chat page's, so
    the two surfaces keep separate live runs even though they share local history. */
export const SIDEBAR_SESSION_ID = "sidebar-session";

/** The sidebar's layout-state class: hidden (off the Chat tab) wins, then expanded vs the
    slim collapsed rail. Extracted so the JSX carries no nested ternary. */
function sidebarStateClass(hidden: boolean, open: boolean): string {
  if (hidden) {
    return "is-hidden";
  }
  return open ? "is-open" : "is-collapsed";
}

export interface ChatSidebarProps {
  /** Hidden on the full Chat tab, where this would just double the chat. The component
      stays mounted (so its conversation persists); CSS removes it from the layout. */
  hidden: boolean;
  /** Expanded vs collapsed to a slim rail. Owned by App so the shell grid can size the
      column to match. */
  open: boolean;
  /** Toggle expanded/collapsed. */
  onToggle: () => void;
  /** Everything RunScreen needs; the sidebar injects `variant` + `sessionId` itself. */
  run: Omit<RunScreenProps, "variant" | "sessionId">;
}

export function ChatSidebar({
  hidden,
  open,
  onToggle,
  run
}: Readonly<ChatSidebarProps>): ReactElement {
  const stateClass = sidebarStateClass(hidden, open);
  return (
    <aside className={`chat-sidebar ${stateClass}`} aria-hidden={hidden} aria-label="Chat">
      {/* The panel stays mounted while collapsed (hidden via the attribute) so the chat
          conversation is never reset by collapsing or switching tabs. */}
      <div className="chat-sidebar-panel" hidden={!open}>
        <div className="chat-sidebar-head">
          <span className="chat-sidebar-title">Chat</span>
          <button
            type="button"
            className="chat-sidebar-collapse"
            onClick={onToggle}
            aria-label="Collapse chat"
            title="Collapse chat"
          >
            <IconCollapse />
          </button>
        </div>
        <div className="chat-sidebar-body">
          <RunScreen {...run} variant="sidebar" sessionId={SIDEBAR_SESSION_ID} />
        </div>
      </div>
      {!open && (
        <button
          type="button"
          className="chat-sidebar-rail"
          onClick={onToggle}
          aria-label="Open chat"
          aria-expanded={open}
          title="Open chat"
        >
          <IconChatBubble />
        </button>
      )}
    </aside>
  );
}

function IconChatBubble(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCollapse(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
