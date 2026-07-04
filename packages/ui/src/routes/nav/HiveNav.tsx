import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import { isPageVisible, TOGGLEABLE_PAGES, type PagePrefs } from "../../pagePrefs";
import type { View } from "../../App";

export interface HiveNavItem {
  view: View;
  label: string;
  icon: ReactElement;
  /** Shown only on small screens (the desktop dock is the chat surface), so the hex is
      dropped from the honeycomb on wide viewports. */
  mobileOnly?: boolean;
}

export interface HiveNavProps {
  /** The full nav list (primary views + the config/trust surfaces) in display order. The
      honeycomb holds them all, filtered by page visibility. */
  items: HiveNavItem[];
  view: View;
  onSelect: (v: View) => void;
  /** Alerts badge count; shown on the Alerts hex inside the honeycomb. */
  unread: number;
  pagePrefs: PagePrefs;
  connected: boolean;
  bridgeUrl: string;
  onBridgeUrl: (s: string) => void;
  onConnect: () => void;
  connectError?: string | undefined;
}

/** One honeycomb row: its cells plus whether it is the half-hex-offset (brick) row. */
interface HiveRow {
  cells: HiveNavItem[];
  offset: boolean;
}

/** Chunk the visible hexes into a brick honeycomb: fixed columns per row, with alternate rows
    offset by half a hex (in CSS) so every hex nestles into a valley of the row above — a true
    tessellation for any count. A lone trailing hex is pulled a neighbour down from the row above
    so no single hex looks "sat upon" by a full row. */
function honeycombRows(items: HiveNavItem[], wide: boolean): HiveRow[] {
  const perRow = wide ? 4 : 3;
  const chunks: HiveNavItem[][] = [];
  for (let index = 0; index < items.length; index += perRow) {
    chunks.push(items.slice(index, index + perRow));
  }
  // Rebalance a lonely singleton last row: borrow one hex from the row above so the last row
  // has at least two and reads balanced (the brick offset keeps the tessellation intact).
  const lastIndex = chunks.length - 1;
  const last = chunks[lastIndex];
  if (chunks.length > 1 && last !== undefined && last.length === 1) {
    const prev = chunks[lastIndex - 1];
    if (prev !== undefined) {
      const moved = prev.pop();
      if (moved !== undefined) {
        last.unshift(moved);
      }
    }
  }
  return chunks.map((cells, index) => ({ cells, offset: index % 2 === 1 }));
}

const WIDE_QUERY = "(min-width: 861px)";

/** The signature HoneyHub launcher: the app-icon hive blooms into a honeycomb of every view
    (primary + config), filtered by page visibility. Replaces the old left activity-bar; content
    runs edge-to-edge. */
export function HiveNav({
  items,
  view,
  onSelect,
  unread,
  pagePrefs,
  connected,
  bridgeUrl,
  onBridgeUrl,
  onConnect,
  connectError
}: Readonly<HiveNavProps>): ReactElement {
  const [open, setOpen] = useState(false);
  // Whether the viewport is wide (desktop). The Chat hex is a phone-only affordance, so it is
  // dropped from the honeycomb when wide — mirroring the old `.nav-item-mobile` CSS hide, but in
  // JS so it never leaves a hole in a chunked row. Defaults to wide (also the jsdom/test path,
  // where matchMedia is absent).
  const [wide, setWide] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia(WIDE_QUERY).matches;
  });
  const hiveRef = useRef<HTMLButtonElement>(null);
  const combRef = useRef<HTMLDivElement>(null);

  // Track the wide/narrow breakpoint so the honeycomb re-chunks and the Chat hex appears on
  // phones. Guarded for environments without matchMedia (jsdom) — there it stays wide.
  useEffect(() => {
    const mm = typeof window === "undefined" ? undefined : window.matchMedia;
    if (typeof mm !== "function") {
      return;
    }
    const mq = mm.call(window, WIDE_QUERY);
    const onChange = (): void => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) {
      hiveRef.current?.focus();
    }
  }, []);

  // Escape closes the bloom and returns focus to the hive. Bound at the document level so it
  // fires wherever focus sits inside the honeycomb.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // On open, move focus to the current view's hex (or the first), so keyboard users land inside
  // the honeycomb rather than behind it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const comb = combRef.current;
    if (comb === null) {
      return;
    }
    const current = comb.querySelector<HTMLButtonElement>('[aria-current="page"]');
    const first = comb.querySelector<HTMLButtonElement>('[role="menuitem"]');
    (current ?? first)?.focus();
  }, [open]);

  // Only show a hex for a page that is core (never in TOGGLEABLE_PAGES) or explicitly visible,
  // and drop the phone-only Chat hex on wide screens.
  const visible = items.filter((item) => {
    if (wide && item.mobileOnly === true) {
      return false;
    }
    return (
      !TOGGLEABLE_PAGES.some((page) => page.view === item.view) ||
      isPageVisible(pagePrefs, item.view)
    );
  });
  const rows = honeycombRows(visible, wide);
  // Flat starting index per row → drives the bloom stagger (transition-delay by position).
  const rowBases: number[] = [];
  rows.reduce((acc, row, index) => {
    rowBases[index] = acc;
    return acc + row.cells.length;
  }, 0);

  const handleSelect = (next: View): void => {
    onSelect(next);
    setOpen(false);
  };

  // Roving arrow-key focus across the honeycomb (a nice-to-have on top of the required
  // Escape-to-close). Wraps at the ends; Home/End jump to the edges.
  const onCombKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const handled = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
    if (!handled.includes(event.key)) {
      return;
    }
    const cells = Array.from(
      combRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    );
    if (cells.length === 0) {
      return;
    }
    event.preventDefault();
    const at = cells.findIndex((cell) => cell === document.activeElement);
    let target = at;
    if (event.key === "Home") {
      target = 0;
    } else if (event.key === "End") {
      target = cells.length - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      target = at < 0 ? 0 : (at + 1) % cells.length;
    } else {
      target = at <= 0 ? cells.length - 1 : at - 1;
    }
    cells[target]?.focus();
  };

  const logoSrc = `${import.meta.env.BASE_URL}icons/icon-512.svg`;

  return (
    <>
      <div className={`hive-launch${open ? " is-open" : ""}`}>
        <button
          ref={hiveRef}
          type="button"
          className="hive-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Open navigation"
          onClick={() => setOpen((prev) => !prev)}
        >
          <img className="hive-button-logo" src={logoSrc} alt="" aria-hidden="true" />
        </button>
      </div>

      {open && (
        <>
          <button
            type="button"
            className="ws-backdrop"
            aria-label="Close navigation"
            onClick={() => close(true)}
          />
          <div className="hive-bloom" aria-label="Navigation">
            <div className="hive-bloom-head">
              <h1 className="hive-bloom-name">HoneyHub</h1>
            </div>

            <div
              ref={combRef}
              className="hive-comb"
              role="menu"
              aria-label="Views"
              onKeyDown={onCombKeyDown}
            >
              {rows.map((row, rowIndex) => (
                <div
                  className={`hive-row${row.offset ? " is-offset" : ""}`}
                  key={rowBases[rowIndex]}
                >
                  {row.cells.map((item, column) => {
                    const isCurrent = item.view === view;
                    const showBadge = item.view === "notifications" && unread > 0;
                    return (
                      <span
                        className="hive-cell-wrap"
                        key={item.view}
                        style={
                          { "--hive-i": (rowBases[rowIndex] ?? 0) + column } as CSSProperties
                        }
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className={`hive-cell${isCurrent ? " is-current" : ""}`}
                          aria-current={isCurrent ? "page" : undefined}
                          aria-label={showBadge ? `${item.label}, ${unread} unread` : undefined}
                          onClick={() => handleSelect(item.view)}
                        >
                          <span className="hive-cell-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                          <span className="hive-cell-label">{item.label}</span>
                        </button>
                        {showBadge && (
                          <span className="hive-cell-badge" aria-hidden="true">
                            {unread}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="hive-foot">
              <div className={`conn-state ${connected ? "is-connected" : "is-mock"}`}>
                <span className="conn-dot" aria-hidden="true" />
                <span>{connected ? "Connected" : "Demo (mock)"}</span>
              </div>
              {!connected && (
                <div className="bridge-connect">
                  <input
                    aria-label="Bridge URL"
                    value={bridgeUrl}
                    onChange={(event) => onBridgeUrl(event.target.value)}
                    placeholder="ws://127.0.0.1:8765/ws?token=…"
                  />
                  <button type="button" onClick={onConnect}>
                    Connect
                  </button>
                  {connectError !== undefined && (
                    <span role="alert" className="settings-error">
                      {connectError}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
