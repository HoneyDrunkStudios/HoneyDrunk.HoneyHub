import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { RepositoriesView } from "./RepositoriesView";

/** Records the writeFile calls (and diff calls) the component makes against the mock. */
class CapturingClient extends MockWireClient {
  writeFileCalls: Array<{ path: string; content: string }> = [];
  gitStageCalls: Array<{ root: string; paths: string[] }> = [];

  override writeFile(path: string, content: string): Promise<void> {
    this.writeFileCalls.push({ path, content });
    return super.writeFile(path, content);
  }

  override gitStage(root: string, paths: string[]): Promise<void> {
    this.gitStageCalls.push({ root, paths });
    return super.gitStage(root, paths);
  }
}

function renderRepos(client = new MockWireClient()) {
  return render(
    <RepositoriesView
      client={client}
      workspaceRoots={["/demo"]}
      defaultWorkspaceRoot="/demo"
      active
    />
  );
}

describe("RepositoriesView", () => {
  it("shows the empty state when there are no workspace roots", () => {
    render(<RepositoriesView client={new MockWireClient()} workspaceRoots={[]} active />);
    expect(
      screen.getByText("Add a workspace in Settings to browse files, view diffs, and edit code here.")
    ).toBeTruthy();
  });

  it("renders the explorer tree and the source-control changes for the folder", async () => {
    renderRepos();

    expect(screen.getByRole("heading", { name: "Repositories" })).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByText("Source control")).toBeTruthy();

    // The root listing populates the tree with the demo repos.
    await waitFor(() => expect(screen.getByRole("button", { name: "HoneyHub" })).toBeTruthy());
    // The dirty repo's changed files render in the source-control panel.
    await waitFor(() => expect(screen.getByText("packages/ui/src/App.tsx")).toBeTruthy());
  });

  it("opens a file from the tree, edits it, and saves through writeFile", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    // Expand the repo folder, then open a file.
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());

    // Enter edit mode, change the draft, and save.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "Edited in HoneyHub." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.writeFileCalls.length).toBe(1));
    expect(client.writeFileCalls[0]?.content).toBe("Edited in HoneyHub.");
    // The save result exits edit mode and the viewer re-reads the persisted content.
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
  });

  it("opens a changed file's diff in the center pane", async () => {
    renderRepos();

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("ctrl-clicks a changed file into the multi-select bulk bar", async () => {
    renderRepos();

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.click(fileButton, { ctrlKey: true });

    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
  });

  it("right-clicks a changed file to open the context menu and stage it", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);

    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stage" }));

    await waitFor(() => expect(client.gitStageCalls.length).toBe(1));
    expect(client.gitStageCalls[0]?.paths).toEqual(["packages/ui/src/App.tsx"]);
  });
});
