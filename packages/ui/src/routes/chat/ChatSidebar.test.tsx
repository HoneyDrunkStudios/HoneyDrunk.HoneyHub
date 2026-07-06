import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("starts a fresh thread from the dock header's New chat control", async () => {
    renderSidebar();
    // Launch a run so the embedded RunScreen is in its live transcript view.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Wire the dock" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
    );
    expect(screen.getByLabelText("Transcript")).toBeTruthy();

    // The dock header's own "New chat" control (distinct from the active-run button inside
    // the body) bumps the new-chat signal, which resets the embedded RunScreen.
    const header = document.querySelector(".chat-sidebar-head") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "New chat" }));

    // Back at the empty composer: the "Do anything" placeholder shows, transcript is gone.
    expect(screen.getByPlaceholderText("Do anything")).toBeTruthy();
    expect(screen.queryByLabelText("Transcript")).toBeNull();
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

  it("toggles the session-history dropdown from the header sessions button", () => {
    renderSidebar();
    // The header no longer shows an inline "Threads" list — the button owns them now.
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.getByRole("dialog", { name: "Sessions" })).toBeTruthy();
    // One unified list of sessions — no Local/Web source tabs.
    expect(screen.queryByRole("tab")).toBeNull();

    // Clicking the button again dismisses it.
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
  });

  it("reopens a synced session from the merged session list and closes the panel", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    // The mock's one durable session shows directly in the single merged list (no Web
    // tab); clicking it reopens the transcript read-only and dismisses the dropdown.
    const list = await screen.findByRole("list", { name: "Sessions" });
    fireEvent.click(await within(list).findByText("Wire the deploy triggers"));

    expect(await screen.findByText("Done. Staged the workflow and opened a PR.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
  });
});
