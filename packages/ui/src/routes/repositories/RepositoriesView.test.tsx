import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { RepositoriesView } from "./RepositoriesView";

/** Records the writes the component makes so tests can assert the bridge calls, and exposes
    an `emitFsChanged` hook + browse/overview counters for the refresh paths. */
class CapturingClient extends MockWireClient {
  writeFileCalls: Array<{ path: string; content: string }> = [];
  gitStageCalls: Array<{ root: string; paths: string[] }> = [];
  gitUnstageCalls: Array<{ root: string; paths: string[] }> = [];
  gitCommitCalls: Array<{ root: string; message: string }> = [];
  gitPushCalls: string[] = [];
  gitPullCalls: string[] = [];
  gitCheckoutCalls: Array<{ root: string; name: string; create?: boolean | undefined }> = [];
  gitDiscardCalls: Array<{ root: string; paths: string[]; untracked?: boolean | undefined }> = [];
  browseDirCount = 0;
  gitOverviewCount = 0;

  override writeFile(path: string, content: string): Promise<void> {
    this.writeFileCalls.push({ path, content });
    return super.writeFile(path, content);
  }

  override gitStage(root: string, paths: string[]): Promise<void> {
    this.gitStageCalls.push({ root, paths });
    return super.gitStage(root, paths);
  }

  override gitUnstage(root: string, paths: string[]): Promise<void> {
    this.gitUnstageCalls.push({ root, paths });
    return super.gitUnstage(root, paths);
  }

  override gitCommit(root: string, message: string): Promise<void> {
    this.gitCommitCalls.push({ root, message });
    return super.gitCommit(root, message);
  }

  override gitPush(root: string): Promise<void> {
    this.gitPushCalls.push(root);
    return super.gitPush(root);
  }

  override gitPull(root: string): Promise<void> {
    this.gitPullCalls.push(root);
    return super.gitPull(root);
  }

  override gitCheckout(root: string, name: string, create?: boolean): Promise<void> {
    this.gitCheckoutCalls.push({ root, name, create });
    return super.gitCheckout(root, name, create);
  }

  override gitDiscard(root: string, paths: string[], untracked?: boolean): Promise<void> {
    this.gitDiscardCalls.push({ root, paths, untracked });
    return super.gitDiscard(root, paths, untracked);
  }

  override browseDir(path = ""): Promise<void> {
    this.browseDirCount += 1;
    return super.browseDir(path);
  }

  override gitOverview(root: string): Promise<void> {
    this.gitOverviewCount += 1;
    return super.gitOverview(root);
  }

  emitFsChanged(paths: string[]): void {
    this.emitDevice({ kind: "fs_changed", paths });
  }
}

/** A repo with both a staged and an unstaged file, so the Staged group + commit box render. */
class StagedRepoClient extends CapturingClient {
  override gitOverview(root: string): Promise<void> {
    this.gitOverviewCount += 1;
    this.emitDevice({
      kind: "git_overview",
      overview: {
        root,
        repos: [
          {
            root: `${root}/HoneyHub`,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [
              { path: "staged.ts", status: "M ", staged: true, untracked: false },
              { path: "unstaged.ts", status: " M", staged: false, untracked: false }
            ],
            clean: false
          }
        ]
      }
    });
    return Promise.resolve();
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

  it("does not load anything while inactive", () => {
    const client = new CapturingClient();
    render(
      <RepositoriesView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active={false}
      />
    );
    // No root listing yet, so the explorer shows the loading hint and nothing was fetched.
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(client.browseDirCount).toBe(0);
    expect(client.gitOverviewCount).toBe(0);
  });

  it("expands a nested directory (lazy-load) then collapses it", async () => {
    renderRepos();

    // Expand the repo folder, then the nested src directory (a second, deeper listing).
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "main.ts" })).toBeTruthy());

    // Collapsing the repo folder hides its children.
    fireEvent.click(screen.getByRole("button", { name: "HoneyHub" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "README.md" })).toBeNull());
  });

  it("opens a file from the tree, edits it, and saves through writeFile", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "Edited in HoneyHub." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.writeFileCalls).toHaveLength(1));
    expect(client.writeFileCalls[0]?.content).toBe("Edited in HoneyHub.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
  });

  it("cancels an edit without writing the file", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "throwaway" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Back to read mode, and nothing was written.
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
    expect(client.writeFileCalls).toHaveLength(0);
  });

  it("surfaces a save failure reported as an ok:false file_written result", async () => {
    class FailingSaveEventClient extends MockWireClient {
      override writeFile(path: string, _content: string): Promise<void> {
        this.emitDevice({
          kind: "file_written",
          result: { path, ok: false, message: "disk was full" }
        });
        return Promise.resolve();
      }
    }
    renderRepos(new FailingSaveEventClient());

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The error shows and we stay in edit mode (Save/Cancel still present).
    await waitFor(() => expect(screen.getByText("disk was full")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("surfaces a save failure when writeFile rejects", async () => {
    class RejectingSaveClient extends MockWireClient {
      override writeFile(_path: string, _content: string): Promise<void> {
        return Promise.reject(new Error("write boom"));
      }
    }
    renderRepos(new RejectingSaveClient());

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("write boom")).toBeTruthy());
  });

  it("opens a changed file's diff in the center pane", async () => {
    renderRepos();

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("shows the truncated note for a very large diff", async () => {
    class TruncatedDiffClient extends CapturingClient {
      override gitDiff(root: string, path?: string): Promise<void> {
        this.emitDevice({
          kind: "git_diff",
          diff: {
            root,
            ...(path === undefined ? {} : { path }),
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            truncated: true
          }
        });
        return Promise.resolve();
      }
    }
    renderRepos(new TruncatedDiffClient());

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    await waitFor(() => expect(screen.getByText("Diff truncated (very large change).")).toBeTruthy());
  });

  it("shows the empty-diff hint when the patch is blank", async () => {
    class EmptyDiffClient extends CapturingClient {
      override gitDiff(root: string, path?: string): Promise<void> {
        this.emitDevice({
          kind: "git_diff",
          diff: { root, ...(path === undefined ? {} : { path }), patch: "   \n", truncated: false }
        });
        return Promise.resolve();
      }
    }
    renderRepos(new EmptyDiffClient());

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    await waitFor(() =>
      expect(
        screen.getByText("No diff (the change may be untracked or staged only).")
      ).toBeTruthy()
    );
  });

  it("tolerates a diff read that rejects", async () => {
    class RejectingDiffClient extends CapturingClient {
      override gitDiff(_root: string, _path?: string): Promise<void> {
        return Promise.reject(new Error("diff boom"));
      }
    }
    renderRepos(new RejectingDiffClient());

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    // The diff pane stays on its loading placeholder; the rejection is swallowed.
    await waitFor(() => expect(screen.getByText("Loading diff…")).toBeTruthy());
  });

  it("shows an error when a file read rejects", async () => {
    class RejectingReadClient extends CapturingClient {
      override readFile(_path: string): Promise<void> {
        return Promise.reject(new Error("read boom"));
      }
    }
    renderRepos(new RejectingReadClient());

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("read boom"));
  });

  it("disables editing for a truncated (too large) file", async () => {
    class TruncatedFileClient extends CapturingClient {
      override readFile(path: string): Promise<void> {
        this.emitDevice({
          kind: "file_contents",
          file: { path, content: "x".repeat(10), truncated: true, byteSize: 10 }
        });
        return Promise.resolve();
      }
    }
    renderRepos(new TruncatedFileClient());

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));

    await waitFor(() => expect(screen.getByText("truncated (too large to edit)")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("ctrl-clicks a changed file into the multi-select bulk bar and bulk-stages/unstages", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.click(fileButton, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());

    const bulk = screen.getByText("1 selected").parentElement as HTMLElement;
    fireEvent.click(within(bulk).getByRole("button", { name: "Stage" }));
    await waitFor(() => expect(client.gitStageCalls).toHaveLength(1));
    expect(client.gitStageCalls[0]?.paths).toEqual(["packages/ui/src/App.tsx"]);

    fireEvent.click(within(bulk).getByRole("button", { name: "Unstage" }));
    await waitFor(() => expect(client.gitUnstageCalls).toHaveLength(1));
  });

  it("right-clicks a changed file to open the context menu and stage it", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);

    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stage" }));

    await waitFor(() => expect(client.gitStageCalls).toHaveLength(1));
    expect(client.gitStageCalls[0]?.paths).toEqual(["packages/ui/src/App.tsx"]);
  });

  it("copies a file path from the context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderRepos();

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);
    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("packages/ui/src/App.tsx");
  });

  it("opens a file and diff from the context menu", async () => {
    renderRepos();

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);
    let menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open file" }));
    // Opening the file reads it into the center pane's file view.
    await waitFor(() => expect(screen.getByText("Edit")).toBeTruthy());

    fireEvent.contextMenu(await screen.findByText("packages/ui/src/App.tsx"));
    menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open diff" }));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
  });

  it("discards a changed file after confirming, and can cancel the confirm", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    // The unstaged file row exposes a Discard action.
    const row = (await screen.findByText("packages/ui/src/App.tsx")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Discard" }));

    // First cancel the confirm — nothing is discarded.
    let dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm action" })).toBeNull());
    expect(client.gitDiscardCalls).toHaveLength(0);

    // Now discard for real.
    fireEvent.click(within(row).getByRole("button", { name: "Discard" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(client.gitDiscardCalls).toHaveLength(1));
    expect(client.gitDiscardCalls[0]?.paths).toEqual(["packages/ui/src/App.tsx"]);
    expect(client.gitDiscardCalls[0]?.untracked).toBe(false);
  });

  it("switches branch through the branch picker (confirming for a dirty tree)", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    const branchSelect = (await screen.findByLabelText("Switch branch")) as HTMLSelectElement;
    // Wait for branches to load so the picker is enabled.
    await waitFor(() => expect(branchSelect.disabled).toBe(false));
    fireEvent.change(branchSelect, { target: { value: "main" } });

    const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(client.gitCheckoutCalls).toHaveLength(1));
    expect(client.gitCheckoutCalls[0]).toMatchObject({ name: "main", create: false });
  });

  it("creates a new branch from the new-branch form", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    const input = (await screen.findByLabelText("New branch name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "feature-x" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(client.gitCheckoutCalls).toHaveLength(1));
    expect(client.gitCheckoutCalls[0]).toMatchObject({ name: "feature-x", create: true });
  });

  it("pulls and pushes through their confirm gates and shows feedback", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    fireEvent.click(await screen.findByRole("button", { name: /Pull/ }));
    let dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(client.gitPullCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("(demo) Already up to date.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Push/ }));
    dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(client.gitPushCalls).toHaveLength(1));
  });

  it("switches the active repository through the repo picker", async () => {
    renderRepos();

    const repoSelect = (await screen.findByLabelText("Repository")) as HTMLSelectElement;
    fireEvent.change(repoSelect, { target: { value: "/demo/HoneyDrunk.AI" } });

    // The second demo repo is clean.
    await waitFor(() => expect(screen.getByText("Working tree clean.")).toBeTruthy());
  });

  it("renders the staged group and stages all unstaged changes", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);

    // Both groups render: a Staged file and an unstaged one.
    await waitFor(() => expect(screen.getByText("staged.ts")).toBeTruthy());
    expect(screen.getByText("unstaged.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unstage all" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(client.gitStageCalls).toHaveLength(1));
    expect(client.gitStageCalls[0]?.paths).toEqual(["."]);
  });

  it("unstages all staged changes", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);

    await waitFor(() => expect(screen.getByText("staged.ts")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Unstage all" }));
    await waitFor(() => expect(client.gitUnstageCalls).toHaveLength(1));
    expect(client.gitUnstageCalls[0]?.paths).toEqual(["."]);
  });

  it("commits a staged change and clears the message", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);

    await waitFor(() => expect(screen.getByText("staged.ts")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "wip: save" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));

    await waitFor(() => expect(client.gitCommitCalls).toHaveLength(1));
    expect(client.gitCommitCalls[0]?.message).toBe("wip: save");
    // The commit leaves the tree clean.
    await waitFor(() => expect(screen.getByText("Working tree clean.")).toBeTruthy());
  });

  it("unstages a staged file from the context menu", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);

    fireEvent.contextMenu(await screen.findByText("staged.ts"));
    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unstage" }));

    await waitFor(() => expect(client.gitUnstageCalls).toHaveLength(1));
    expect(client.gitUnstageCalls[0]?.paths).toEqual(["staged.ts"]);
  });

  it("refreshes on demand and on a matching fs_changed event, but ignores unrelated paths", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    await waitFor(() => expect(screen.getByText("packages/ui/src/App.tsx")).toBeTruthy());
    const baselineBrowse = client.browseDirCount;
    const baselineOverview = client.gitOverviewCount;

    // The manual Refresh button re-reads the tree + overview.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.gitOverviewCount).toBeGreaterThan(baselineOverview));
    expect(client.browseDirCount).toBeGreaterThan(baselineBrowse);

    const afterRefreshOverview = client.gitOverviewCount;
    // An unrelated path outside the folder is ignored.
    client.emitFsChanged(["/somewhere/else/x.ts"]);
    expect(client.gitOverviewCount).toBe(afterRefreshOverview);

    // A path inside the workspace triggers a refresh.
    client.emitFsChanged(["/demo/HoneyHub/src/main.ts"]);
    await waitFor(() => expect(client.gitOverviewCount).toBeGreaterThan(afterRefreshOverview));
  });

  it("resets to an empty-folder state when the workspace folder changes", async () => {
    render(
      <RepositoriesView
        client={new MockWireClient()}
        workspaceRoots={["/demo", "/other"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "HoneyHub" })).toBeTruthy());

    // Switch to a folder the scripted mock has no listing for → empty folder.
    fireEvent.change(screen.getByLabelText("Workspace folder"), { target: { value: "/other" } });
    await waitFor(() => expect(screen.getByText("Empty folder.")).toBeTruthy());
  });
});
