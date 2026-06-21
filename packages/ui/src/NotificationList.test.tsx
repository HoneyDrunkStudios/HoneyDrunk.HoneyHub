import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationList } from "./NotificationList";
import type { AppNotification } from "./notifications";

const sample: AppNotification[] = [
  {
    id: "work:1",
    kind: "pr_review",
    title: "PR needs your review",
    body: "acme/widgets: Fix the thing",
    link: "https://example.test/pr/1",
    createdAt: "2026-06-07T12:00:00Z",
    read: false
  },
  {
    id: "dl:ns/orders:3",
    kind: "dead_letter",
    title: "New dead-letter message",
    body: "orders (ns): 3 dead-letter",
    createdAt: "2026-06-07T12:01:00Z",
    read: true
  }
];

describe("NotificationList", () => {
  it("shows an empty state and a zero badge", () => {
    render(
      <NotificationList notifications={[]} active onMarkAllRead={() => {}} onClear={() => {}} />
    );
    expect(screen.getByText(/No alerts yet/i)).toBeTruthy();
    expect(screen.getByLabelText("Notification count").textContent).toBe("0");
  });

  it("renders notifications with a count badge, a link, and read/clear controls", () => {
    const onMarkAllRead = vi.fn();
    const onClear = vi.fn();
    render(
      <NotificationList
        notifications={sample}
        active
        onMarkAllRead={onMarkAllRead}
        onClear={onClear}
      />
    );
    expect(screen.getByLabelText("Notification count").textContent).toBe("2");

    const list = screen.getByRole("list", { name: "Notification list" });
    expect(within(list).getByText("PR needs your review")).toBeTruthy();
    expect(within(list).getByText("New dead-letter message")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "open" }).getAttribute("href")).toBe(
      "https://example.test/pr/1"
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
