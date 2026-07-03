import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { ChatSidebar, type ChatSidebarProps } from "./ChatSidebar";

function renderSidebar(overrides: Partial<ChatSidebarProps> = {}) {
  const client = new MockWireClient();
  const onToggle = overrides.onToggle ?? vi.fn();
  const onResize = overrides.onResize ?? vi.fn();
  render(
    <ChatSidebar
      hidden={overrides.hidden ?? false}
      open={overrides.open ?? true}
      onToggle={onToggle}
      width={overrides.width ?? 380}
      onResize={onResize}
      run={{
        client,
        availableBackends: ["claude.local"],
        workspaceRoots: ["/repo"],
        catalog: [],
        ...overrides.run
      }}
    />
  );
  return { client, onToggle, onResize };
}

describe("ChatSidebar", () => {
  it("renders the full chat and streams an agent reply", async () => {
    renderSidebar();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    expect(
      await screen.findByText("I can take that on. Which file should I change?")
    ).toBeTruthy();
  });

  it("is hidden on the Chat tab", () => {
    renderSidebar({ hidden: true });
    const sidebar = document.querySelector(".chat-sidebar");
    expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
    expect(sidebar?.className).toContain("is-hidden");
  });

  it("collapses to a rail and exposes an open control", () => {
    // Collapsed: the panel is hidden and a rail "Open chat" button shows.
    renderSidebar({ open: false });
    expect(screen.getByRole("button", { name: "Open chat" })).toBeTruthy();
  });

  it("toggles via the collapse control", () => {
    const onToggle = vi.fn();
    renderSidebar({ open: true, onToggle });
    fireEvent.click(screen.getByRole("button", { name: "Collapse chat" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("resizes with the arrow keys on the focused divider (clamped)", () => {
    const onResize = vi.fn();
    renderSidebar({ width: 400, onResize });
    const divider = screen.getByRole("separator", { name: "Resize chat" });
    // The dock hangs off the right edge: ArrowLeft widens, ArrowRight narrows.
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledWith(416);
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(onResize).toHaveBeenCalledWith(384);
  });
});
