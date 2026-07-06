import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadsMenu,
  formatRelativeTime,
  mergeThreadRows,
  type ThreadRow,
  type ThreadsMenuProps
} from "./ThreadsMenu";

const LOCAL: ThreadRow[] = [
  {
    id: "a",
    source: "local",
    title: "Active thread",
    timestamp: "2026-07-05T05:00:00Z",
    status: "active"
  },
  {
    id: "b",
    source: "local",
    title: "Done thread",
    timestamp: "2026-07-04T12:00:00Z",
    status: "done"
  }
];
const WEB: ThreadRow[] = [
  { id: "w1", source: "web", title: "Synced session", timestamp: "2026-06-20T12:00:00Z" }
];

function renderMenu(overrides: Partial<ThreadsMenuProps> = {}) {
  const handlers = {
    onQuery: vi.fn(),
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn()
  };
  render(
    <ThreadsMenu
      threads={overrides.threads ?? mergeThreadRows(LOCAL, WEB)}
      query={overrides.query ?? ""}
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-05T12:00:00Z");

  it("formats sub-minute, minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-07-05T11:59:40Z", now)).toBe("now");
    expect(formatRelativeTime("2026-07-05T11:58:00Z", now)).toBe("2m");
    expect(formatRelativeTime("2026-07-05T05:00:00Z", now)).toBe("7h");
    expect(formatRelativeTime("2026-07-04T12:00:00Z", now)).toBe("1d");
    expect(formatRelativeTime("2026-06-20T12:00:00Z", now)).toBe("15d");
  });

  it("returns empty string for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("mergeThreadRows", () => {
  it("dedupes a shared id to one row, preferring the local record", () => {
    const local: ThreadRow[] = [
      {
        id: "x",
        source: "local",
        title: "Local X",
        timestamp: "2026-07-01T00:00:00Z",
        pinned: true,
        status: "done"
      }
    ];
    const web: ThreadRow[] = [
      // Same id as the local row — must collapse to ONE row (the local one wins).
      { id: "x", source: "web", title: "Web X", timestamp: "2026-07-02T00:00:00Z" },
      { id: "y", source: "web", title: "Web Y", timestamp: "2026-07-03T00:00:00Z" }
    ];

    const merged = mergeThreadRows(local, web);

    // The shared id "x" appears once; the unique web row "y" survives.
    expect(merged).toHaveLength(2);
    // Pinned rows sort first (even though "x" is the oldest), and "x" kept the LOCAL
    // record's source + title.
    expect(merged[0]?.id).toBe("x");
    expect(merged[0]?.source).toBe("local");
    expect(merged[0]?.title).toBe("Local X");
    // The remaining (unpinned) row falls under it.
    expect(merged[1]?.id).toBe("y");
  });

  it("sorts unpinned rows most-recent first", () => {
    const merged = mergeThreadRows(LOCAL, WEB);
    expect(merged.map((row) => row.id)).toEqual(["a", "b", "w1"]);
  });
});

describe("ThreadsMenu", () => {
  it("shows one merged list with a status light on local rows only", () => {
    renderMenu();
    const list = screen.getByRole("list", { name: "Sessions" });
    // Local and synced rows share the single list — no source chrome.
    expect(within(list).getByText("Active thread")).toBeTruthy();
    expect(within(list).getByText("Done thread")).toBeTruthy();
    expect(within(list).getByText("Synced session")).toBeTruthy();
    // The status dots ride only on the local rows (the synced row carries none).
    expect(within(list).getByLabelText("Run active")).toBeTruthy();
    expect(within(list).getByLabelText("Chat done with answers")).toBeTruthy();
    expect(
      within(list).getAllByLabelText(/Run active|Chat done with answers/)
    ).toHaveLength(2);
  });

  it("has no source tabs", () => {
    renderMenu();
    expect(screen.queryByRole("tab", { name: "Local" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Web" })).toBeNull();
  });

  it("opens a row and routes open() by the row's source", () => {
    const { onOpen, onClose } = renderMenu({ threads: [LOCAL[0]!, WEB[0]!] });

    fireEvent.click(screen.getByText("Active thread"));
    expect(onOpen).toHaveBeenCalledWith("a", "local");
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Synced session"));
    expect(onOpen).toHaveBeenCalledWith("w1", "web");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renames a local row through its source", () => {
    const { onRename } = renderMenu({ threads: [LOCAL[0]!] });
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    const input = screen.getByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("a", "Renamed", "local");
  });

  it("deletes a web row through its source, only after a confirming second click", () => {
    const { onDelete } = renderMenu({ threads: [WEB[0]!] });
    const del = screen.getByRole("button", { name: "Delete session" });
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
    // Now armed: the label flips to "Confirm delete" and a second click fires with source.
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(onDelete).toHaveBeenCalledWith("w1", "web");
  });

  it("highlights the currently-open row", () => {
    renderMenu({ currentId: "a" });
    const row = screen.getByText("Active thread").closest("li");
    expect(row?.className).toContain("is-current");
  });

  it("dismisses via the backdrop and Escape", () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
