import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Notification } from "@honeydrunk/honeyhub-types";
import { NotificationList } from "./NotificationList";

const sample: Notification[] = [
  {
    id: "n1",
    kind: "pr_opened",
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    link: "https://example.test/pr/1",
    createdAt: "2026-06-07T12:00:00Z"
  },
  {
    id: "n2",
    kind: "needs_input",
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    createdAt: "2026-06-07T12:01:00Z"
  }
];

describe("NotificationList", () => {
  it("shows an empty state and a zero badge", () => {
    render(<NotificationList notifications={[]} />);
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    expect(screen.getByLabelText("Unread notifications").textContent).toBe("0");
  });

  it("renders notifications with a count badge and a link", () => {
    render(<NotificationList notifications={sample} />);
    expect(screen.getByLabelText("Unread notifications").textContent).toBe("2");

    const list = screen.getByRole("list", { name: "Notification list" });
    expect(within(list).getByText("PR opened")).toBeTruthy();
    expect(within(list).getByText("Needs input")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "open" }).getAttribute("href")).toBe(
      "https://example.test/pr/1"
    );
  });
});
