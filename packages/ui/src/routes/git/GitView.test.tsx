import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { GitView } from "./GitView";

const ROOTS = ["C:/repos/Studios"];

// The folder the mock's overview is scoped to (matches what the view requests first).
const FOLDER = ROOTS[0] as string;
const DIRTY = `${FOLDER}/HoneyHub`;
const CLEAN = `${FOLDER}/HoneyDrunk.AI`;

/**
 * A MockWireClient that also lets a test push an arbitrary device-scoped event through the
 * same subscription the view listens on. Used to drive the scoping branches (an overview /
 * diff for a different root must be ignored) that the scripted mock never emits on its own.
 */
class PushableWireClient extends MockWireClient {
  private readonly captured = new Set<(event: BridgeEvent) => void>();

  override subscribe(handler: (event: BridgeEvent) => void): () => void {
    this.captured.add(handler);
    const off = super.subscribe(handler);
    return () => {
      this.captured.delete(handler);
      off();
    };
  }

  /** Push a device-scoped event (empty session/run ids) to every live subscriber. */
  push(payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: "test-event",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-21T00:00:00.000Z",
      payload
    };
    act(() => {
      for (const handler of this.captured) {
        handler(event);
      }
    });
  }
}

/** Expand the dirty repo (HoneyHub) and wait for its detail panel to render. */
async function openDirtyRepo(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /HoneyHub.*changed/i }));
  await screen.findByText("packages/ui/src/App.tsx");
}

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

  it("scopes the workspace folder select to the configured roots and re-queries on change", async () => {
    const roots = ["C:/repos/Studios", "C:/repos/Other"];
    const client = new MockWireClient();
    const overview = vi.spyOn(client, "gitOverview");
    render(<GitView client={client} active workspaceRoots={roots} defaultWorkspaceRoot="C:/repos/Other" />);

    // The default root is pre-selected and queried first.
    expect(await screen.findByRole("button", { name: /HoneyHub.*changed/i })).toBeTruthy();
    expect(overview).toHaveBeenCalledWith("C:/repos/Other");

    const select = screen.getByLabelText("Workspace folder") as HTMLSelectElement;
    expect(select.value).toBe("C:/repos/Other");
    expect(screen.getByRole("option", { name: "Studios" })).toBeTruthy();

    fireEvent.change(select, { target: { value: "C:/repos/Studios" } });
    await waitFor(() => expect(overview).toHaveBeenCalledWith("C:/repos/Studios"));
  });

  it("ignores a git_overview emitted for a different folder", async () => {
    const client = new PushableWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await screen.findByRole("button", { name: /HoneyHub.*changed/i });

    // An overview for a folder this view is NOT showing must not replace the data.
    client.push({
      kind: "git_overview",
      overview: {
        root: "C:/some/other/folder",
        repos: [
          {
            root: "C:/some/other/folder/Decoy",
            branch: "main",
            ahead: 0,
            behind: 0,
            files: [],
            clean: true
          }
        ]
      }
    });

    expect(screen.queryByRole("button", { name: /Decoy/i })).toBeNull();
    // The original repos are still listed.
    expect(screen.getByRole("button", { name: /HoneyHub.*changed/i })).toBeTruthy();
  });

  it("shows the empty state when a folder has no repos", async () => {
    const client = new PushableWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await screen.findByRole("button", { name: /HoneyHub.*changed/i });

    client.push({ kind: "git_overview", overview: { root: FOLDER, repos: [] } });
    expect(await screen.findByText(/No git repositories found/i)).toBeTruthy();
  });

  /** Make `gitOverview` emit a FOLDER overview whose single repo has one staged + one unstaged
      file, so the Staged group (Unstage all / Commit) renders. The scripted mock never stages,
      so a test that needs a staged file overrides the overview at the source. */
  function stubStagedOverview(client: PushableWireClient): void {
    vi.spyOn(client, "gitOverview").mockImplementation(async (root: string) => {
      client.push({
        kind: "git_overview",
        overview: {
          root,
          repos: [
            {
              root: `${root}/HoneyHub`,
              branch: "feat/honeyhub-desktop-shell",
              ahead: 2,
              behind: 0,
              clean: false,
              files: [
                { path: "src/staged.ts", status: "M ", staged: true, untracked: false },
                { path: "src/unstaged.ts", status: " M", staged: false, untracked: false }
              ]
            }
          ]
        }
      });
    });
  }

  it("stages all unstaged files and unstages all staged files", async () => {
    const client = new PushableWireClient();
    stubStagedOverview(client);
    // No-op the writes so the host re-emit doesn't overwrite the pushed staged status.
    const unstage = vi.spyOn(client, "gitUnstage").mockResolvedValue(undefined);
    const stage = vi.spyOn(client, "gitStage").mockResolvedValue(undefined);
    render(<GitView client={client} active workspaceRoots={ROOTS} />);

    fireEvent.click(await screen.findByRole("button", { name: /HoneyHub.*changed/i }));

    // Unstage all first: a no-op write leaves `busy` set (no git_op clears it), so assert this
    // before staging, while the buttons are still enabled.
    fireEvent.click(await screen.findByRole("button", { name: "Unstage all" }));
    expect(unstage).toHaveBeenCalledWith(DIRTY, ["."]);

    // Clear busy with the host's op result so the Stage all button re-enables.
    client.push({ kind: "git_op", result: { root: DIRTY, op: "unstage", ok: true } });
    fireEvent.click(screen.getByRole("button", { name: "Stage all" }));
    expect(stage).toHaveBeenCalledWith(DIRTY, ["."]);
  });

  it("commits and clears the message on success", async () => {
    const client = new PushableWireClient();
    stubStagedOverview(client);
    const commit = vi.spyOn(client, "gitCommit").mockResolvedValue(undefined);
    render(<GitView client={client} active workspaceRoots={ROOTS} />);

    fireEvent.click(await screen.findByRole("button", { name: /HoneyHub.*changed/i }));
    const box = (await screen.findByLabelText("Commit message")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "wire the git client" } });
    fireEvent.click(screen.getByRole("button", { name: /^Commit/ }));
    expect(commit).toHaveBeenCalledWith(DIRTY, "wire the git client");

    // The host answers a successful commit with a git_op; the message box clears.
    client.push({ kind: "git_op", result: { root: DIRTY, op: "commit", ok: true, message: "1 file changed" } });
    await waitFor(() => expect((screen.getByLabelText("Commit message") as HTMLTextAreaElement).value).toBe(""));
  });

  it("confirms a pull, and cancelling does not run it", async () => {
    const client = new MockWireClient();
    const pull = vi.spyOn(client, "gitPull");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    // Cancel first: the op must NOT fire.
    fireEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pull).not.toHaveBeenCalled();

    // Confirm next: the op fires.
    fireEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(pull).toHaveBeenCalledWith(DIRTY);
    expect(await screen.findByText(/Already up to date/i)).toBeTruthy();
  });

  it("switches branch via the select (clean repo skips the confirm)", async () => {
    const client = new MockWireClient();
    const checkout = vi.spyOn(client, "gitCheckout");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);

    // Expand the CLEAN repo, whose checkout needs no confirmation.
    fireEvent.click(await screen.findByRole("button", { name: /HoneyDrunk\.AI.*clean/i }));
    const branchSelect = await screen.findByLabelText("Switch branch");
    fireEvent.change(branchSelect, { target: { value: "main" } });

    expect(checkout).toHaveBeenCalledWith(CLEAN, "main", false);
    // No confirm dialog appeared for a clean repo.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switching branch in a dirty repo is confirmation-gated", async () => {
    const client = new MockWireClient();
    const checkout = vi.spyOn(client, "gitCheckout");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    const branchSelect = await screen.findByLabelText("Switch branch");
    fireEvent.change(branchSelect, { target: { value: "main" } });
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    expect(checkout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(checkout).toHaveBeenCalledWith(DIRTY, "main", false);
  });

  it("creates a branch from the new-branch form on a clean repo (no confirm)", async () => {
    const client = new MockWireClient();
    const checkout = vi.spyOn(client, "gitCheckout");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    // The clean repo: a create-branch needs no confirmation.
    fireEvent.click(await screen.findByRole("button", { name: /HoneyDrunk\.AI.*clean/i }));

    const input = await screen.findByLabelText("New branch name");
    fireEvent.change(input, { target: { value: "feat/new-thing" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    // Creating a branch is a checkout with create=true; the input clears afterward.
    expect(checkout).toHaveBeenCalledWith(CLEAN, "feat/new-thing", true);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("deletes a branch (confirmation-gated)", async () => {
    const client = new MockWireClient();
    const del = vi.spyOn(client, "gitDeleteBranch");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    // The delete select lists branches other than the current one (here: "main").
    const deleteSelect = await screen.findByLabelText("Delete branch");
    fireEvent.change(deleteSelect, { target: { value: "main" } });
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(del).toHaveBeenCalledWith(DIRTY, "main");
    expect(await screen.findByText(/deleted main/i)).toBeTruthy();
  });

  it("discards a single file (confirmation-gated)", async () => {
    const client = new MockWireClient();
    const discard = vi.spyOn(client, "gitDiscard");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    // Discard a single file: the per-file Discard button.
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0] as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(discard).toHaveBeenCalled();
    const [discardRoot, discardPaths] = discard.mock.calls[0] as [string, string[], boolean?];
    expect(discardRoot).toBe(DIRTY);
    expect(discardPaths).toContain("packages/ui/src/App.tsx");
    expect(await screen.findByText(/discarded changes/i)).toBeTruthy();
  });

  it("discards all changes from the detail bar (confirmation-gated)", async () => {
    const client = new MockWireClient();
    const discardAll = vi.spyOn(client, "gitDiscardAll");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(discardAll).toHaveBeenCalledWith(DIRTY);
    expect(await screen.findByText(/discarded all changes/i)).toBeTruthy();
  });

  it("opens the all-changes diff from the detail bar", async () => {
    const client = new MockWireClient();
    const diff = vi.spyOn(client, "gitDiff");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    fireEvent.click(screen.getByRole("button", { name: "View all changes" }));
    // All-changes diff requests the root with no path.
    expect(diff).toHaveBeenCalledWith(DIRTY, undefined);
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
  });

  it("ignores a git_diff that does not match the pending request", async () => {
    const client = new PushableWireClient();
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await openDirtyRepo();

    // Ask for one file's diff (this sets the pending (root, path)).
    fireEvent.click(screen.getByText("packages/ui/src/App.tsx"));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());

    // A diff for a DIFFERENT path under the same root must not clobber the shown diff.
    client.push({
      kind: "git_diff",
      diff: {
        root: DIRTY,
        path: "some/other/file.ts",
        patch: "+++ b/some/other/file.ts\n+intruder line\n",
        truncated: false
      }
    });
    expect(screen.queryByText(/intruder line/)).toBeNull();
    expect(screen.getByText(/const view = "chat";/)).toBeTruthy();
  });

  it("refreshes the overview when a watched file changes on disk", async () => {
    const client = new PushableWireClient();
    const overview = vi.spyOn(client, "gitOverview");
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    await screen.findByRole("button", { name: /HoneyHub.*changed/i });
    const initial = overview.mock.calls.length;

    // A change under the folder triggers a silent re-query.
    client.push({ kind: "fs_changed", paths: [`${DIRTY}/notes.md`] });
    await waitFor(() => expect(overview.mock.calls.length).toBeGreaterThan(initial));

    // A change outside the folder is ignored.
    const after = overview.mock.calls.length;
    client.push({ kind: "fs_changed", paths: ["C:/elsewhere/x.ts"] });
    expect(overview.mock.calls.length).toBe(after);
  });

  it("surfaces an error when the overview read fails", async () => {
    const client = new MockWireClient();
    vi.spyOn(client, "gitOverview").mockRejectedValue(new Error("denied"));
    render(<GitView client={client} active workspaceRoots={ROOTS} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/could not read git status/i);
  });
});
