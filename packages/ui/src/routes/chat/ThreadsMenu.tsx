import { useEffect, useState, type ReactElement } from "react";

// The dock's session-history dropdown: a floating panel anchored to the header button.
// A search box over a single scrollable list of session rows (title + relative time,
// with a status light + rename/delete on the active/hovered row). It shows ONE unified
// list of sessions — the this-device (local) and synced (web) histories are merged and
// deduped by the parent (RunScreen) into a tagged row array, so the source is internal
// only and never surfaced to the operator. Purely presentational: the parent owns the
// thread DATA and the open/rename/delete handlers, which route by each row's source.

/** Where a row's data lives, so open/rename/delete route to the right store. Internal to
    the app — the row UI is identical regardless of source. */
export type ThreadSource = "local" | "web";

/** One session row, mapped by the parent from either the local summaries or the synced
    sessions into a shape the panel can render without knowing which is which. */
export interface ThreadRow {
  id: string;
  /** Which store this row came from; open/rename/delete are dispatched on it. */
  source: ThreadSource;
  /** The row's display title (truncated with ellipsis when it overflows). */
  title: string;
  /** RFC3339 timestamp shown right-aligned as a relative time ("7h" / "2d"). */
  timestamp: string;
  /** Pinned rows sort to the top of the merged list (recency otherwise). */
  pinned?: boolean;
  /** Local rows carry a run-status light; web rows (no run state) omit it. */
  status?: "active" | "done";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A wire timestamp as a compact relative age: "now"/"1m" under an hour, "7h" under a
    day, else whole days ("1d"/"15d"). Unparseable timestamps render nothing. `now` is a
    parameter so the format is deterministically testable. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const delta = Math.max(0, now - then);
  if (delta < MINUTE_MS) {
    return "now";
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h`;
  }
  return `${Math.floor(delta / DAY_MS)}d`;
}

/** Merge the this-device (local) and synced (web) rows into one list: deduped by id (the
    local record wins on a collision — it carries the richer run status), pinned rows
    first, then most-recent timestamp first. Pure so the merge is unit-testable. */
export function mergeThreadRows(local: ThreadRow[], web: ThreadRow[]): ThreadRow[] {
  const byId = new Map<string, ThreadRow>();
  // Seed with web, then let local overwrite a shared id (local wins).
  for (const row of web) {
    byId.set(row.id, row);
  }
  for (const row of local) {
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => {
    const pinA = a.pinned === true ? 1 : 0;
    const pinB = b.pinned === true ? 1 : 0;
    if (pinA !== pinB) {
      return pinB - pinA;
    }
    return a.timestamp < b.timestamp ? 1 : -1;
  });
}

export interface ThreadsMenuProps {
  /** The single, already-merged + deduped + sorted list of session rows, each tagged
      with its source so actions route correctly. */
  threads: ThreadRow[];
  /** The search query + setter (filters the merged list in the parent). */
  query: string;
  onQuery: (query: string) => void;
  /** The currently-open/active session id: its row is highlighted and always shows its
      rename/delete actions (other rows reveal them on hover). */
  currentId?: string;
  /** Open / rename / delete a row, dispatched by the parent on the row's source. */
  onOpen: (id: string, source: ThreadSource) => void;
  onRename: (id: string, title: string, source: ThreadSource) => void;
  onDelete: (id: string, source: ThreadSource) => void;
  /** Dismiss the panel (row selection, backdrop click, or Escape). */
  onClose: () => void;
}

export function ThreadsMenu({
  threads,
  query,
  onQuery,
  currentId,
  onOpen,
  onRename,
  onDelete,
  onClose
}: Readonly<ThreadsMenuProps>): ReactElement {
  // The row being renamed (id + draft + source) and the row whose delete awaits a second
  // click — the same two-step affordances as the old inline list.
  const [renaming, setRenaming] = useState<
    { id: string; draft: string; source: ThreadSource } | undefined
  >(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined);

  // Escape dismisses the whole panel — but not while renaming, where Escape only cancels
  // the rename (handled on the input). Guarding on `renaming` keeps the two Escapes from
  // colliding without fighting synthetic-vs-native event propagation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && renaming === undefined) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, renaming]);

  const commitRename = () => {
    if (renaming !== undefined) {
      if (renaming.draft.trim() !== "") {
        onRename(renaming.id, renaming.draft.trim(), renaming.source);
      }
      setRenaming(undefined);
    }
  };

  // Opening a row switches to it and closes the panel (Claude Code's picker behavior).
  const openThread = (thread: ThreadRow) => {
    onOpen(thread.id, thread.source);
    onClose();
  };

  return (
    <>
      {/* Outside-click dismiss: a transparent button behind the panel. */}
      <button
        type="button"
        className="threads-menu-backdrop"
        aria-label="Close sessions"
        onClick={onClose}
      />
      <div className="threads-menu" role="dialog" aria-label="Sessions">
        <div className="threads-search">
          <IconSearch />
          <input
            className="threads-search-input"
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>

        <ul className="threads-list" aria-label="Sessions">
          {threads.length === 0 ? (
            <li className="threads-empty">No sessions</li>
          ) : (
            threads.map((thread) => {
              const isCurrent = thread.id === currentId;
              return (
                <li
                  key={thread.id}
                  className={`threads-row${isCurrent ? " is-current" : ""}`}
                >
                  {renaming?.id === thread.id ? (
                    <input
                      className="threads-rename"
                      type="text"
                      aria-label="Session name"
                      value={renaming.draft}
                      autoFocus
                      onChange={(event) =>
                        setRenaming({
                          id: thread.id,
                          draft: event.target.value,
                          source: thread.source
                        })
                      }
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          commitRename();
                        } else if (event.key === "Escape") {
                          setRenaming(undefined);
                        }
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="threads-open"
                        onClick={() => openThread(thread)}
                      >
                        {thread.status !== undefined && (
                          <span
                            className={`recent-status recent-status--${thread.status}`}
                            aria-label={
                              thread.status === "active"
                                ? "Run active"
                                : "Chat done with answers"
                            }
                          />
                        )}
                        <span className="threads-title">{thread.title}</span>
                        <span className="threads-time">
                          {formatRelativeTime(thread.timestamp)}
                        </span>
                      </button>
                      <span className="threads-actions">
                        <button
                          type="button"
                          className="threads-action"
                          aria-label="Rename session"
                          title="Rename"
                          onClick={() =>
                            setRenaming({
                              id: thread.id,
                              draft: thread.title,
                              source: thread.source
                            })
                          }
                        >
                          <IconPencil />
                        </button>
                        <button
                          type="button"
                          className={`threads-action${
                            confirmingDelete === thread.id ? " is-danger" : ""
                          }`}
                          aria-label={
                            confirmingDelete === thread.id ? "Confirm delete" : "Delete session"
                          }
                          title={
                            confirmingDelete === thread.id ? "Click again to delete" : "Delete"
                          }
                          onClick={() => {
                            if (confirmingDelete === thread.id) {
                              onDelete(thread.id, thread.source);
                              setConfirmingDelete(undefined);
                            } else {
                              setConfirmingDelete(thread.id);
                            }
                          }}
                          onBlur={() => setConfirmingDelete(undefined)}
                        >
                          <IconTrash />
                        </button>
                      </span>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </>
  );
}

function IconSearch(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function IconPencil(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function IconTrash(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
