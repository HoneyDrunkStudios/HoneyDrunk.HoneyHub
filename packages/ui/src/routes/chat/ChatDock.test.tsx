import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { ChatDock } from "./ChatDock";

function renderDock(hidden = false) {
  const client = new MockWireClient();
  render(
    <ChatDock
      client={client}
      hidden={hidden}
      availableBackends={["claude.local"]}
      workspaceRoots={["/repo"]}
      catalog={[]}
    />
  );
  return client;
}

describe("ChatDock", () => {
  it("opens, sends a message, and shows the streamed agent reply", async () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The user's turn renders, and the mock's complete agent reply arrives.
    expect(screen.getByText("hello")).toBeTruthy();
    expect(
      await screen.findByText("I can take that on. Which file should I change?")
    ).toBeTruthy();
  });

  it("is hidden on the Chat tab", () => {
    renderDock(true);
    const dock = document.querySelector(".chat-dock");
    expect(dock?.getAttribute("aria-hidden")).toBe("true");
    expect(dock?.className).toContain("is-hidden");
  });

  it("disables sending without a provider", () => {
    const client = new MockWireClient();
    render(
      <ChatDock client={client} hidden={false} availableBackends={[]} workspaceRoots={[]} catalog={[]} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByText(/Enable a provider in Settings/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });
});
