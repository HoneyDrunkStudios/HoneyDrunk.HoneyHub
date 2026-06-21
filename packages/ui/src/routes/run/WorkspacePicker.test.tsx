import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { WorkspacePicker } from "./WorkspacePicker";

// Opens the (initially-closed) picker popover by clicking the workspace chip.
function openPicker(): void {
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
}

describe("WorkspacePicker", () => {
  it("shows the no-workspace label when nothing is selected", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={[]}
        value=""
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("No workspace");
  });

  it("shows the basename of the selected workspace", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub"]}
        value="/repos/HoneyHub"
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Workspace" }).textContent).toContain("HoneyHub");
  });

  it("toggles the popover open and closed via the chip", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={[]}
        value=""
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    expect(screen.queryByLabelText("Select workspace")).toBeNull();
    openPicker();
    expect(screen.getByLabelText("Select workspace")).toBeTruthy();
    // Clicking the chip again closes it.
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.queryByLabelText("Select workspace")).toBeNull();
  });

  it("selects 'no workspace' and closes", () => {
    const client = new MockWireClient();
    const onSelect = vi.fn();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub"]}
        value="/repos/HoneyHub"
        onSelect={onSelect}
        onAddRoots={() => undefined}
      />
    );
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: /No workspace/ }));
    expect(onSelect).toHaveBeenCalledWith("");
    expect(screen.queryByLabelText("Select workspace")).toBeNull();
  });

  it("selects a configured root and closes", () => {
    const client = new MockWireClient();
    const onSelect = vi.fn();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub", "/repos/Lore"]}
        value=""
        onSelect={onSelect}
        onAddRoots={() => undefined}
      />
    );
    openPicker();
    const list = screen.getByLabelText("Configured locations");
    // Click the row option whose title is the full root path.
    fireEvent.click(within(list).getByTitle("/repos/Lore"));
    expect(onSelect).toHaveBeenCalledWith("/repos/Lore");
    expect(screen.queryByLabelText("Select workspace")).toBeNull();
  });

  it("hides the default-star affordance when onSetDefault is omitted", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub"]}
        value=""
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    openPicker();
    // No star button at all without the affordance.
    expect(screen.queryByRole("button", { name: /default/ })).toBeNull();
  });

  it("marks a non-default root as the default via the star", () => {
    const client = new MockWireClient();
    const onSetDefault = vi.fn();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub", "/repos/Lore"]}
        value=""
        defaultRoot="/repos/HoneyHub"
        onSelect={() => undefined}
        onAddRoots={() => undefined}
        onSetDefault={onSetDefault}
      />
    );
    openPicker();
    // Lore is not the default, so its star offers to set it.
    fireEvent.click(screen.getByRole("button", { name: "Set Lore as default" }));
    expect(onSetDefault).toHaveBeenCalledWith("/repos/Lore");
  });

  it("renders the current default with a filled star and the default tag", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={["/repos/HoneyHub", "/repos/Lore"]}
        value=""
        defaultRoot="/repos/HoneyHub"
        onSelect={() => undefined}
        onAddRoots={() => undefined}
        onSetDefault={() => undefined}
      />
    );
    openPicker();
    const list = screen.getByLabelText("Configured locations");
    // The default row shows the "default" tag and a pressed star.
    expect(within(list).getByText("default")).toBeTruthy();
    const star = screen.getByRole("button", { name: "HoneyHub is the default" });
    expect(star.getAttribute("aria-pressed")).toBe("true");
  });

  it("omits the configured-locations list when there are no roots", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={[]}
        value=""
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    openPicker();
    expect(screen.queryByLabelText("Configured locations")).toBeNull();
    // The browse affordance is always present.
    expect(screen.getByText(/Browse for a folder/)).toBeTruthy();
  });

  it("closes via the backdrop", () => {
    const client = new MockWireClient();
    render(
      <WorkspacePicker
        client={client}
        roots={[]}
        value=""
        onSelect={() => undefined}
        onAddRoots={() => undefined}
      />
    );
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Close workspace picker" }));
    expect(screen.queryByLabelText("Select workspace")).toBeNull();
  });
});
