import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { clampChatDockWidth } from "../../chatDock";
import { RunScreen, type RunScreenProps } from "../run/RunScreen";

// The right-hand chat dock — THE chat surface on desktop. It renders the same
// full-featured chat as the small-screen Chat page (session history, model/provider
// picker, new chat, slash menu, agents, file + image attachments) in a compact,
// single-column `sidebar` variant docked on the right of every page, resizable by
// dragging its left edge (clamped, persisted).
//
// It stays mounted even when collapsed (visibility is CSS-toggled), so the conversation
// survives both a collapse and a tab switch.

/** The session id the dock's chat runs under — distinct from the small-screen Chat
    page's, so the two surfaces keep separate live runs even though they share local
    history. */
export const SIDEBAR_SESSION_ID = "sidebar-session";

/** The dock's layout-state class: hidden (on the small-screen Chat page) wins, then
    expanded vs the slim collapsed rail. Extracted so the JSX carries no nested
    ternary. */
function sidebarStateClass(hidden: boolean, open: boolean): string {
  if (hidden) {
    return "is-hidden";
  }
  return open ? "is-open" : "is-collapsed";
}

export interface ChatSidebarProps {
  /** Hidden on the small-screen Chat page, where it would double the chat. The
      component stays mounted (so its conversation persists); CSS removes it. */
  hidden: boolean;
  /** Expanded vs collapsed to a slim rail. Owned by App so the shell grid can size the
      column to match. */
  open: boolean;
  /** Toggle expanded/collapsed. */
  onToggle: () => void;
  /** Report a dragged width (already clamped) so App can size the shell column. */
  onResize: (width: number) => void;
  /** Everything RunScreen needs; the dock injects `variant` + `sessionId` itself. */
  run: Omit<RunScreenProps, "variant" | "sessionId">;
}

export function ChatSidebar({
  hidden,
  open,
  onToggle,
  onResize,
  run
}: Readonly<ChatSidebarProps>): ReactElement {
  const dragging = useRef(false);
  const draggedWidth = useRef<number | undefined>(undefined);

  // Drag-to-resize: the dock is anchored to the right edge, so its width is the
  // distance from the pointer to the window's right side. Pointer capture keeps the
  // events flowing to the handle even when the pointer leaves it mid-drag. While
  // dragging, the width is applied imperatively to the shell's CSS variable (a React
  // state update per pointer-move would re-render the whole app ~100x/sec); the
  // single `onResize` on release commits state + persistence.
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) {
      return;
    }
    const width = clampChatDockWidth(window.innerWidth - event.clientX);
    draggedWidth.current = width;
    const shell = event.currentTarget.closest<HTMLElement>(".app-shell");
    shell?.style.setProperty("--chat-dock-w", `${width}px`);
  };
  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) {
      return;
    }
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (draggedWidth.current !== undefined) {
      onResize(draggedWidth.current);
      draggedWidth.current = undefined;
    }
  };

  const stateClass = sidebarStateClass(hidden, open);
  return (
    <aside className={`chat-sidebar ${stateClass}`} aria-hidden={hidden} aria-label="Chat">
      {/* The panel stays mounted while collapsed (hidden via the attribute) so the chat
          conversation is never reset by collapsing or switching tabs. */}
      <div className="chat-sidebar-panel" hidden={!open}>
        <div
          className="chat-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
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
