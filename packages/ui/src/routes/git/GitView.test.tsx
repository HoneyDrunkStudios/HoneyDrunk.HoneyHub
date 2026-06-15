import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { GitView } from "./GitView";

const ROOTS = ["C:/repos/HoneyHub"];

describe("GitView", () => {
  it("shows branch + changed files and opens a file diff", async () => {
    const client = new MockWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);

    // The mock scripts a dirty branch with two files.
    expect(await screen.findByText("feat/honeyhub-desktop-shell")).toBeTruthy();
    expect(screen.getByText("packages/ui/src/App.tsx")).toBeTruthy();
    expect(screen.getByText("2 changed")).toBeTruthy();

    // Clicking a file loads its diff.
    fireEvent.click(screen.getByText("packages/ui/src/App.tsx"));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
    expect(screen.getByText(/const view = "chat";/)).toBeTruthy();
  });

  it("prompts to add a workspace when none are configured", () => {
    render(<GitView client={new MockWireClient()} active workspaceRoots={[]} />);
    expect(screen.getByText(/Add a workspace in Settings/i)).toBeTruthy();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.gitStatus.bind(client);
    client.gitStatus = (root: string) => {
      calls += 1;
      return original(root);
    };
    render(<GitView client={client} active={false} workspaceRoots={ROOTS} />);
    expect(calls).toBe(0);
  });
});
