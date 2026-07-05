import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import {
  CHAT_DOCK_MAX_WIDTH,
  CHAT_DOCK_MIN_WIDTH,
  clampChatDockWidth
} from "../../chatDock";
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
  /** The current dock width (px), for the separator's value semantics + keyboard resize. */
  width: number;
  /** Report a new width (already clamped) so App can size the shell column. */
  onResize: (width: number) => void;
  /** Everything RunScreen needs; the dock injects `variant` + `sessionId` itself. */
  run: Omit<RunScreenProps, "variant" | "sessionId">;
}

/** How far one arrow-key press moves the dock edge (px). */
const KEYBOARD_RESIZE_STEP = 16;

export function ChatSidebar({
  hidden,
  open,
  onToggle,
  width,
  onResize,
  run
}: Readonly<ChatSidebarProps>): ReactElement {
  const dragging = useRef(false);
  const draggedWidth = useRef<number | undefined>(undefined);
  // Bumped by the header "New chat" button; RunScreen watches it and resets to a fresh
  // thread. Kept here (not in App) so the dock owns its own new-chat control.
  const [newChatSignal, setNewChatSignal] = useState(0);
  // Whether the header's session-history dropdown is open. Owned here (the button lives
  // in the dock header) and passed down so RunScreen — which holds the thread data and
  // open/rename/delete handlers — renders the ThreadsMenu overlay.
  const [threadsMenuOpen, setThreadsMenuOpen] = useState(false);

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
  // Keyboard resize on the focused separator: the dock hangs off the right edge, so
  // ArrowLeft widens it and ArrowRight narrows it. Each press commits through the
  // same clamped `onResize` path as a drag release.
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
    onResize(clampChatDockWidth(width + delta));
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
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize chat"
          aria-valuenow={width}
          aria-valuemin={CHAT_DOCK_MIN_WIDTH}
          aria-valuemax={CHAT_DOCK_MAX_WIDTH}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onKeyDown={onResizeKeyDown}
        />
        <div className="chat-sidebar-head">
          <span className="chat-sidebar-title">Chat</span>
          <div className="chat-sidebar-head-actions">
            {/* Always-available "New chat": start a fresh thread from any state (empty,
                mid-run, or history). The current chat is persisted, so it stays in the
                Chats list below to reopen. */}
            <button
              type="button"
              className="chat-sidebar-new"
              onClick={() => setNewChatSignal((signal) => signal + 1)}
              aria-label="New chat"
              title="New chat"
            >
              <IconPlus />
            </button>
            {/* Session history: this button toggles a dropdown of past sessions (one
                merged list of this-device + synced), replicating Claude Code's session
                picker. RunScreen renders the actual panel from the passed-down open state. */}
            <button
              type="button"
              className="chat-sidebar-history"
              onClick={() => setThreadsMenuOpen((open) => !open)}
              aria-label="Session history"
              aria-haspopup="dialog"
              aria-expanded={threadsMenuOpen}
              title="Session history"
            >
              <IconSessions />
            </button>
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
        </div>
        <div className="chat-sidebar-body">
          <RunScreen
            {...run}
            variant="sidebar"
            sessionId={SIDEBAR_SESSION_ID}
            newChatSignal={newChatSignal}
            threadsMenuOpen={threadsMenuOpen}
            onCloseThreadsMenu={() => setThreadsMenuOpen(false)}
          />
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

function IconPlus(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
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

// A stacked-list glyph (bulleted rows) that reads as "your sessions" — deliberately not a
// clock. Filled bullet dots on the left mark it as a list of things rather than a plain
// hamburger menu; stroke matches the other header icons.
function IconSessions(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
