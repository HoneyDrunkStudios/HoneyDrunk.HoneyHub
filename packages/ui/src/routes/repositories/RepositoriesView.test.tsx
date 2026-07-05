import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DirListing, GitStatus } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { RepositoriesView, repoForFile } from "./RepositoriesView";

// Monaco can't render in jsdom, so stub the lazy CodeEditor with a plain textarea that mirrors
// its props contract (value/onChange/onSave/readOnly). Its aria-label carries the file's basename
// so tests can target "Edit <file>", and it's directly editable, matching the new no-"Edit"-button
// flow where a file opens straight into the editor.
vi.mock("./CodeEditor", () => ({
  default: (props: {
    path: string;
    value: string;
    onChange: (value: string) => void;
    onSave: () => void;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={`Edit ${props.path.split(/[\\/]/).pop() ?? props.path}`}
      value={props.value}
      readOnly={props.readOnly ?? false}
      onChange={(event) => props.onChange(event.target.value)}
    />
  )
}));

// The Monaco side-by-side DiffEditor can't render in jsdom either, so stub the lazy DiffViewer
// with plain <pre>s that surface its original/modified props (and the path) for assertions.
vi.mock("./DiffViewer", () => ({
  default: (props: { path: string; original: string; modified: string }) => (
    <div data-testid="diff-viewer" data-path={props.path}>
      <pre data-testid="diff-original">{props.original}</pre>
      <pre data-testid="diff-modified">{props.modified}</pre>
    </div>
  )
}));

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
  gitFileVersionsCalls: Array<{ root: string; path: string }> = [];
  browseDirCount = 0;
  gitOverviewCount = 0;

  override gitFileVersions(root: string, path: string): Promise<void> {
    this.gitFileVersionsCalls.push({ root, path });
    return super.gitFileVersions(root, path);
  }

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

// The VS Code activity rail shows only one left panel at a time. Explorer is the default; switch
// to "Source control" before any git interaction, back to "Explorer" for tree interaction. The
// Source control icon's accessible name gains a "(N changes)" suffix once the overview loads, so
// match it by prefix.
function showPanel(name: "Explorer" | "Source control"): void {
  const matcher = name === "Source control" ? /^Source control/ : name;
  fireEvent.click(screen.getByRole("button", { name: matcher }));
}

/** A two-repo folder (both dirty) plus a browse tree with a file under each, so opening a file in
    one repo can be observed to switch Source Control to that repo. */
class TwoRepoClient extends MockWireClient {
  override gitOverview(root: string): Promise<void> {
    const repos: GitStatus[] = [
      {
        root: `${root}/HoneyHub`,
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [{ path: "a.ts", status: " M", staged: false, untracked: false }],
        clean: false
      },
      {
        root: `${root}/HoneyDrunk.AI`,
        branch: "main",
        ahead: 0,
        behind: 0,
        files: [{ path: "b.ts", status: " M", staged: false, untracked: false }],
        clean: false
      }
    ];
    this.emitDevice({ kind: "git_overview", overview: { root, repos } });
    return Promise.resolve();
  }

  override browseDir(path = ""): Promise<void> {
    const tree: Record<string, DirListing> = {
      "/demo": {
        path: "/demo",
        entries: [
          { name: "HoneyHub", kind: "dir" },
          { name: "HoneyDrunk.AI", kind: "dir" }
        ],
        truncated: false
      },
      "/demo/HoneyHub": {
        path: "/demo/HoneyHub",
        parent: "/demo",
        entries: [{ name: "a.ts", kind: "file", size: 10 }],
        truncated: false
      },
      "/demo/HoneyDrunk.AI": {
        path: "/demo/HoneyDrunk.AI",
        parent: "/demo",
        entries: [{ name: "b.ts", kind: "file", size: 10 }],
        truncated: false
      }
    };
    const listing = tree[path] ?? { path, parent: "", entries: [], truncated: false };
    this.emitDevice({ kind: "dir_listing", listing });
    return Promise.resolve();
  }
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
    // Explorer is the default panel: the tree shows, the source-control panel is not mounted.
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.queryByText("Source control")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "HoneyHub" })).toBeTruthy());

    // Switching the rail to Source control swaps the sidebar: the tree is gone, the git panel
    // and the dirty repo's changed files render.
    showPanel("Source control");
    expect(screen.getByText("Source control")).toBeTruthy();
    expect(screen.queryByText("Files")).toBeNull();
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

  it("opens a file directly in the editor and saves an edit through writeFile", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    // The file opens straight into the editor, seeded with its on-disk contents.
    const editor = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    expect(editor.value).toBe("# HoneyHub\n\nA scripted demo readme.\n");

    fireEvent.change(editor, { target: { value: "Edited in HoneyHub." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.writeFileCalls).toHaveLength(1));
    expect(client.writeFileCalls[0]?.content).toBe("Edited in HoneyHub.");
    // After the save round-trips, the editor re-seeds from disk → not dirty → Save disabled.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
    );
  });

  it("reverts an unsaved edit without writing the file", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const editor = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "throwaway" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    // The editor snaps back to the on-disk text, and nothing was written.
    await waitFor(() =>
      expect((screen.getByLabelText("Edit README.md") as HTMLTextAreaElement).value).toBe(
        "# HoneyHub\n\nA scripted demo readme.\n"
      )
    );
    expect(client.writeFileCalls).toHaveLength(0);
  });

  it("toggles a markdown file between the editor and a rendered preview of the live draft", async () => {
    renderRepos();

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    // A markdown file defaults to Edit: the mocked editor shows the raw source.
    const editor = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    expect(editor.value).toBe("# HoneyHub\n\nA scripted demo readme.\n");

    // Edit the draft, then preview: the preview must reflect the UNSAVED draft, not the disk text.
    fireEvent.change(editor, { target: { value: "# Draft\n\nlive preview body" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    // The editor is unmounted; the rendered markdown shows inside .markdown-body.
    expect(screen.queryByLabelText("Edit README.md")).toBeNull();
    const rendered = await screen.findByText("live preview body");
    expect(rendered.closest("article")?.className).toContain("markdown-body");

    // Toggling back to Edit restores the editor, still holding the unsaved draft.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const back = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    expect(back.value).toBe("# Draft\n\nlive preview body");
  });

  it("shows no markdown preview toggle for a non-markdown file", async () => {
    renderRepos();

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));

    await screen.findByLabelText("Edit main.ts");
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
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
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The error shows and the edit stays dirty (Revert still enabled).
    await waitFor(() => expect(screen.getByText("disk was full")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Revert" }).hasAttribute("disabled")).toBe(false);
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
    const editor = await screen.findByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("write boom")).toBeTruthy());
  });

  it("opens a changed file's diff in the center pane", async () => {
    const client = new CapturingClient();
    renderRepos(client);
    showPanel("Source control");

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    // The side-by-side DiffViewer mounts with the file's two versions...
    const viewer = await screen.findByTestId("diff-viewer");
    expect(viewer.getAttribute("data-path")).toBe("packages/ui/src/App.tsx");
    expect(screen.getByTestId("diff-original").textContent).toContain('const view = "run";');
    expect(screen.getByTestId("diff-modified").textContent).toContain('const view = "chat";');
    // ...and the unified git_diff still supplies the +/- stat header.
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    // Opening a per-file diff fetches both file versions for the DiffEditor.
    expect(client.gitFileVersionsCalls).toHaveLength(1);
    expect(client.gitFileVersionsCalls[0]?.path).toBe("packages/ui/src/App.tsx");
    expect(client.gitFileVersionsCalls[0]?.root).toMatch(/HoneyHub$/);
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
    showPanel("Source control");

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    await waitFor(() => expect(screen.getByText("Diff truncated (very large change).")).toBeTruthy());
  });

  it("shows the empty-diff hint when there are no file versions and the patch is blank", async () => {
    // The empty-patch hint is the repo-level (unified) fallback, reached only when no file
    // versions arrive — so this client emits a blank patch and no git_file_versions.
    class EmptyDiffClient extends CapturingClient {
      override gitDiff(root: string, path?: string): Promise<void> {
        this.emitDevice({
          kind: "git_diff",
          diff: { root, ...(path === undefined ? {} : { path }), patch: "   \n", truncated: false }
        });
        return Promise.resolve();
      }
      override gitFileVersions(_root: string, _path: string): Promise<void> {
        // No versions reply: stay on the unified patch fallback.
        return Promise.resolve();
      }
    }
    renderRepos(new EmptyDiffClient());
    showPanel("Source control");

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
      override gitFileVersions(_root: string, _path: string): Promise<void> {
        return Promise.reject(new Error("versions boom"));
      }
    }
    renderRepos(new RejectingDiffClient());
    showPanel("Source control");

    fireEvent.click(await screen.findByText("packages/ui/src/App.tsx"));

    // The diff pane stays on its loading placeholder; both rejections are swallowed.
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

  it("opens a truncated (too large) file read-only", async () => {
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
    const editor = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("ctrl-clicks a changed file into the multi-select bulk bar and bulk-stages/unstages", async () => {
    const client = new CapturingClient();
    renderRepos(client);
    showPanel("Source control");

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
    showPanel("Source control");

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
    showPanel("Source control");

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);
    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));

    expect(writeText).toHaveBeenCalledWith("packages/ui/src/App.tsx");
  });

  it("opens a file and diff from the context menu", async () => {
    renderRepos();
    showPanel("Source control");

    const fileButton = await screen.findByText("packages/ui/src/App.tsx");
    fireEvent.contextMenu(fileButton);
    let menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open file" }));
    // Opening the file reads it into the center pane's editor.
    await screen.findByLabelText("Edit App.tsx");

    fireEvent.contextMenu(await screen.findByText("packages/ui/src/App.tsx"));
    menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open diff" }));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
  });

  it("discards a changed file after confirming, and can cancel the confirm", async () => {
    const client = new CapturingClient();
    renderRepos(client);
    showPanel("Source control");

    // The unstaged file row exposes a Discard action.
    const row = (await screen.findByText("packages/ui/src/App.tsx")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Discard" }));

    // First cancel the confirm; nothing is discarded.
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
    showPanel("Source control");

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
    showPanel("Source control");

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
    showPanel("Source control");

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
    showPanel("Source control");

    const repoSelect = (await screen.findByLabelText("Repository")) as HTMLSelectElement;
    fireEvent.change(repoSelect, { target: { value: "/demo/HoneyDrunk.AI" } });

    // The second demo repo is clean.
    await waitFor(() => expect(screen.getByText("Working tree clean.")).toBeTruthy());
  });

  it("renders the staged group and stages all unstaged changes", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);
    showPanel("Source control");

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
    showPanel("Source control");

    await waitFor(() => expect(screen.getByText("staged.ts")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Unstage all" }));
    await waitFor(() => expect(client.gitUnstageCalls).toHaveLength(1));
    expect(client.gitUnstageCalls[0]?.paths).toEqual(["."]);
  });

  it("commits a staged change and clears the message", async () => {
    const client = new StagedRepoClient();
    renderRepos(client);
    showPanel("Source control");

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
    showPanel("Source control");

    fireEvent.contextMenu(await screen.findByText("staged.ts"));
    const menu = await screen.findByRole("menu", { name: "File actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Unstage" }));

    await waitFor(() => expect(client.gitUnstageCalls).toHaveLength(1));
    expect(client.gitUnstageCalls[0]?.paths).toEqual(["staged.ts"]);
  });

  it("refreshes on demand and on a matching fs_changed event, but ignores unrelated paths", async () => {
    const client = new CapturingClient();
    renderRepos(client);
    showPanel("Source control");

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

  it("opens files as tabs, switches between them via the tab strip, and closes a tab", async () => {
    renderRepos();

    // Open README.md → one tab, active.
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await screen.findByLabelText("Edit README.md");
    expect(screen.getByRole("tab", { name: "README.md" }).getAttribute("aria-selected")).toBe("true");

    // Open src/main.ts → two tabs, main.ts becomes active.
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));
    await screen.findByLabelText("Edit main.ts");
    expect(screen.getByRole("tab", { name: "README.md" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "main.ts" }).getAttribute("aria-selected")).toBe("true");

    // Click the README tab to switch back.
    fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
    await screen.findByLabelText("Edit README.md");
    expect(screen.getByRole("tab", { name: "README.md" }).getAttribute("aria-selected")).toBe("true");

    // Close the active README tab → main.ts remains and becomes active again.
    fireEvent.click(screen.getByRole("button", { name: "Close README.md" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "README.md" })).toBeNull());
    expect(screen.getByRole("tab", { name: "main.ts" })).toBeTruthy();
    await screen.findByLabelText("Edit main.ts");
  });

  it("flags a tab dirty while its buffer has unsaved edits", async () => {
    renderRepos();

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const editor = await screen.findByLabelText("Edit README.md");

    const tabEl = () => screen.getByRole("tab", { name: "README.md" }).closest(".repos-tab") as HTMLElement;
    expect(tabEl().className).not.toContain("is-dirty");

    fireEvent.change(editor, { target: { value: "unsaved change" } });
    await waitFor(() => expect(tabEl().className).toContain("is-dirty"));
  });

  it("re-activates an already-open file (keeping its unsaved edit) instead of duplicating the tab", async () => {
    renderRepos();

    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    const editor = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "work in progress" } });

    // Switch away to another file…
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));
    await screen.findByLabelText("Edit main.ts");

    // …then re-open README from the tree: same single tab, unsaved draft intact.
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    const back = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    expect(back.value).toBe("work in progress");
    expect(screen.getAllByRole("tab", { name: "README.md" })).toHaveLength(1);
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

  describe("repoForFile", () => {
    const repos: GitStatus[] = [
      { root: "/w/HoneyHub", ahead: 0, behind: 0, files: [], clean: true },
      { root: "/w/HoneyHub/nested", ahead: 0, behind: 0, files: [], clean: true },
      { root: "/w/Other", ahead: 0, behind: 0, files: [], clean: true }
    ];

    it("picks the longest matching root so a nested repo wins over its parent", () => {
      expect(repoForFile(repos, "/w/HoneyHub/nested/deep/file.ts")).toBe("/w/HoneyHub/nested");
      expect(repoForFile(repos, "/w/HoneyHub/src/file.ts")).toBe("/w/HoneyHub");
      expect(repoForFile(repos, "/w/Other/x.ts")).toBe("/w/Other");
    });

    it("returns undefined when no repo contains the file", () => {
      expect(repoForFile(repos, "/elsewhere/x.ts")).toBeUndefined();
      // Boundary-aware: a sibling that merely shares a name prefix is not a container.
      expect(repoForFile(repos, "/w/HoneyHubLegacy/x.ts")).toBeUndefined();
    });
  });

  it("badges the Source control icon with the active repo's change count", async () => {
    renderRepos();
    // The default active repo (HoneyHub) has 2 changed files → a count badge inside the SC button.
    const scButton = screen.getByRole("button", { name: /^Source control/ });
    await waitFor(() => expect(within(scButton).getByText("2")).toBeTruthy());
    // The count also rides the accessible name for assistive tech.
    expect(screen.getByRole("button", { name: "Source control (2 changes)" })).toBeTruthy();
  });

  it("follows the opened file's repo: opening a file in another repo switches Source Control", async () => {
    renderRepos(new TwoRepoClient());

    // Both repos are dirty; the first (HoneyHub) is the default active repo.
    showPanel("Source control");
    await waitFor(() =>
      expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe("/demo/HoneyHub")
    );

    // Open b.ts, which lives under HoneyDrunk.AI, from the explorer.
    showPanel("Explorer");
    fireEvent.click(await screen.findByRole("button", { name: "HoneyDrunk.AI" }));
    fireEvent.click(await screen.findByRole("button", { name: "b.ts" }));
    await screen.findByLabelText("Edit b.ts");

    // Source Control now follows the focused file to the HoneyDrunk.AI repo.
    showPanel("Source control");
    await waitFor(() =>
      expect((screen.getByLabelText("Repository") as HTMLSelectElement).value).toBe(
        "/demo/HoneyDrunk.AI"
      )
    );
  });

  it("saves every dirty open tab through Save all", async () => {
    const client = new CapturingClient();
    renderRepos(client);

    // Open README (unedited) → Save all is present but disabled.
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    fireEvent.click(await screen.findByRole("button", { name: "README.md" }));
    await screen.findByLabelText("Edit README.md");
    expect(screen.getByRole("button", { name: "Save all" }).hasAttribute("disabled")).toBe(true);

    // Open main.ts, edit it, then switch back to README and edit that too → two dirty tabs.
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "main.ts" }));
    const main = (await screen.findByLabelText("Edit main.ts")) as HTMLTextAreaElement;
    fireEvent.change(main, { target: { value: "// edited main" } });

    fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
    const readme = (await screen.findByLabelText("Edit README.md")) as HTMLTextAreaElement;
    fireEvent.change(readme, { target: { value: "edited readme" } });

    await waitFor(() => expect(screen.getByText(/2 unsaved/)).toBeTruthy());
    const saveAll = screen.getByRole("button", { name: "Save all" });
    expect(saveAll.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveAll);

    // Both dirty tabs are written through the same writeFile path.
    await waitFor(() => expect(client.writeFileCalls).toHaveLength(2));
    const written = client.writeFileCalls.map((call) => call.path).sort();
    expect(written).toEqual(["/demo/HoneyHub/README.md", "/demo/HoneyHub/src/main.ts"]);
  });
});
