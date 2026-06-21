import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { GitView } from "./GitView";

const ROOTS = ["C:/repos/Studios"];

describe("GitView", () => {
  it("lists the repos in a folder and opens a file diff", async () => {
    const client = new MockWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);

    // The mock discovers two repos under the folder: one clean, one dirty.
    expect(await screen.findByRole("button", { name: /HoneyDrunk\.AI.*clean/i })).toBeTruthy();
    const dirty = screen.getByRole("button", { name: /HoneyHub.*changed/i });
    fireEvent.click(dirty);

    // Expanded: changed files + a commit box.
    expect(await screen.findByText("packages/ui/src/App.tsx")).toBeTruthy();
    expect(screen.getByLabelText("Commit message")).toBeTruthy();

    // Clicking a file loads its diff.
    fireEvent.click(screen.getByText("packages/ui/src/App.tsx"));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
    expect(screen.getByText(/const view = "chat";/)).toBeTruthy();
  });

  it("runs a write op (stage) and shows feedback", async () => {
    const client = new MockWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    fireEvent.click(await screen.findByRole("button", { name: /HoneyHub.*changed/i }));
    await screen.findByText("packages/ui/src/App.tsx");

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    expect(await screen.findByText(/\(demo\) staged/)).toBeTruthy();
  });

  it("confirms before a push, then pushes", async () => {
    const client = new MockWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    fireEvent.click(await screen.findByRole("button", { name: /HoneyHub.*changed/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^Push/ }));
    // A confirmation modal gates the write.
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/pushed to origin/)).toBeTruthy();
  });

  it("prompts to add a workspace when none are configured", () => {
    render(<GitView client={new MockWireClient()} active workspaceRoots={[]} />);
    expect(screen.getByText(/Add a workspace in Settings/i)).toBeTruthy();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.gitOverview.bind(client);
    client.gitOverview = (root: string) => {
      calls += 1;
      return original(root);
    };
    render(<GitView client={client} active={false} workspaceRoots={ROOTS} />);
    expect(calls).toBe(0);
  });
});
