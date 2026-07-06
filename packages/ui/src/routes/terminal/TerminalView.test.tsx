import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { TerminalView } from "./TerminalView";

// xterm can't render in jsdom, so stub the lazy TerminalPane with a marker that reports the
// root it was mounted with and exposes buttons to drive its onStatus contract (the page
// reacts to open/closed/denied). This mirrors how RepositoriesView.test stubs CodeEditor.
vi.mock("./TerminalPane", () => ({
  default: (props: {
    root: string;
    onStatus?: (status: string, detail: string | null) => void;
  }) => (
    <div data-testid="terminal-pane" data-root={props.root}>
      <button type="button" onClick={() => props.onStatus?.("open", null)}>
        pane-open
      </button>
      <button type="button" onClick={() => props.onStatus?.("closed", "exited")}>
        pane-exit
      </button>
      <button type="button" onClick={() => props.onStatus?.("denied", "relay")}>
        pane-deny
      </button>
    </div>
  )
}));

describe("TerminalView", () => {
  it("prompts to add a root when the allowlist is empty", () => {
    render(<TerminalView client={new MockWireClient()} active workspaceRoots={[]} />);
    expect(screen.getByText(/Add a workspace root in Settings/i)).toBeTruthy();
  });

  it("renders nothing when not the active page", () => {
    const { container } = render(
      <TerminalView client={new MockWireClient()} active={false} workspaceRoots={["/repo"]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens a terminal pane for the selected root and closes it", async () => {
    render(
      <TerminalView
        client={new MockWireClient()}
        active
        workspaceRoots={["/repo-a", "/repo-b"]}
        defaultWorkspaceRoot="/repo-b"
      />
    );
    // No pane before opening.
    expect(screen.queryByTestId("terminal-pane")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));

    const pane = await screen.findByTestId("terminal-pane");
    expect(pane.getAttribute("data-root")).toBe("/repo-b");

    // Drive the pane to "open", then close via the toolbar.
    fireEvent.click(screen.getByRole("button", { name: "pane-open" }));
    expect(screen.getByText(/Shell running/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close terminal/i }));
    await waitFor(() => expect(screen.queryByTestId("terminal-pane")).toBeNull());
  });

  it("surfaces the desktop-local-only note when the host denies a relay terminal", async () => {
    render(<TerminalView client={new MockWireClient()} active workspaceRoots={["/repo"]} />);
    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));
    const pane = await screen.findByTestId("terminal-pane");
    fireEvent.click(within(pane).getByRole("button", { name: "pane-deny" }));
    await waitFor(() =>
      expect(screen.getByText(/desktop-local-only/i)).toBeTruthy()
    );
  });
});
