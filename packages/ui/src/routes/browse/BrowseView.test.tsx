import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { BrowseView } from "./BrowseView";

// A mock that records every subscribed handler so a test can push arbitrary bridge events
// (fs_changed, an off-scope git_overview, a correlated git_diff) through the same callback
// the component registered. The component subscribes twice (two effects), so dispatch fans
// out to all live handlers. Also counts the read-side calls we assert on.
class CapturingClient extends MockWireClient {
  readonly captured = new Set<(event: BridgeEvent) => void>();
  gitDiffCalls: Array<{ root: string; path?: string }> = [];
  gitOverviewRoots: string[] = [];
  browseCalls = 0;

  override subscribe(handler: (event: BridgeEvent) => void): () => void {
    this.captured.add(handler);
    const inner = super.subscribe(handler);
    return () => {
      this.captured.delete(handler);
      inner();
    };
  }

  override gitDiff(root: string, path?: string): Promise<void> {
    this.gitDiffCalls.push(path === undefined ? { root } : { root, path });
    return super.gitDiff(root, path);
  }

  override gitOverview(root: string): Promise<void> {
    this.gitOverviewRoots.push(root);
    return super.gitOverview(root);
  }

  override browseDir(path = ""): Promise<void> {
    this.browseCalls += 1;
    return super.browseDir(path);
  }

  /** Dispatch a device-scoped event (empty session/run ids) to every live handler, exactly
      as the bridge would push it down the wire. */
  push(payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: "test-event",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-21T00:00:00.000Z",
      payload
    };
    for (const handler of [...this.captured]) {
      handler(event);
    }
  }
}

describe("BrowseView", () => {
  it("opens a location and re-reads it on manual Refresh", async () => {
    const client = new MockWireClient();
    let browseCalls = 0;
    const original = client.browseDir.bind(client);
    client.browseDir = (path?: string) => {
      browseCalls += 1;
      return original(path);
    };

    render(<BrowseView client={client} workspaceRoots={["/demo"]} active />);

    // Navigate into the location → its listing loads (the mock scripts /demo).
    fireEvent.click(screen.getByRole("button", { name: "/demo" }));
    // The directory entry is a button (the changed-files panel also mentions repo names).
    await waitFor(() => expect(screen.getByRole("button", { name: "HoneyHub" })).toBeTruthy());
    const afterOpen = browseCalls;

    // The Refresh button appears once inside a folder; clicking re-reads the same path.
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(browseCalls).toBe(afterOpen + 1));
  });

  it("shows no Refresh button at the locations (top) level", () => {
    render(<BrowseView client={new MockWireClient()} workspaceRoots={["/demo"]} active />);
    expect(screen.queryByRole("button", { name: "Refresh folder" })).toBeNull();
  });

  it("renders the configured-locations list and the empty-locations hint", () => {
    // With roots, the top level lists each picked location (renderLocationEntries).
    const { rerender } = render(
      <BrowseView client={new MockWireClient()} workspaceRoots={["/demo"]} active />
    );
    expect(screen.getByRole("button", { name: "/demo" })).toBeTruthy();

    // With no roots, the empty-state hint renders instead.
    rerender(<BrowseView client={new MockWireClient()} workspaceRoots={[]} active />);
    expect(screen.getByText("No repo locations yet. Add one in Settings.")).toBeTruthy();
  });

  it("lists directory entries and opens a file from one", async () => {
    const client = new MockWireClient();
    render(<BrowseView client={client} workspaceRoots={["/demo"]} active />);

    // Open the location, then a child folder (renderDirEntries: a dir button + a file button).
    fireEvent.click(screen.getByRole("button", { name: "/demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy());

    // Clicking a file entry routes through openFile and the viewer shows its content.
    fireEvent.click(screen.getByRole("button", { name: "README.md" }));
    await waitFor(() => expect(screen.getByText("A scripted demo readme.")).toBeTruthy());
  });

  it("runs a filename search and renders the result entries", async () => {
    const client = new MockWireClient();
    render(<BrowseView client={client} workspaceRoots={["/demo"]} active />);

    // Get into a folder so search is enabled (the input is disabled at the top level).
    fireEvent.click(screen.getByRole("button", { name: "/demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy());

    // Type a query: the debounced search fires and renderSearchEntries lists the hits.
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "README" } });
    await waitFor(() =>
      expect(screen.getByTitle("/demo/HoneyHub/README.md")).toBeTruthy()
    );
  });

  it("shows the no-match hint when a search has no hits", async () => {
    const client = new MockWireClient();
    render(<BrowseView client={client} workspaceRoots={["/demo"]} active />);

    fireEvent.click(screen.getByRole("button", { name: "/demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "HoneyHub" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy());

    // A query that matches nothing renders the empty-results hint.
    fireEvent.change(screen.getByLabelText("Search files"), {
      target: { value: "no-such-file-anywhere" }
    });
    await waitFor(() => expect(screen.getByText("No files match.")).toBeTruthy());
  });

  it("renders the changed-files panel from a git_overview scoped to the default workspace", async () => {
    const client = new CapturingClient();
    // At the locations level the changes scope is the default workspace; the activation
    // effect fetches it and the mock answers with a git_overview rooted at "/demo".
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    // The panel groups changed files by repo (only the dirty repo from the mock shows).
    const panel = await screen.findByRole("list", { name: "Changed files" });
    expect(within(panel).getByText("HoneyHub")).toBeTruthy();
    // The clean repo (HoneyDrunk.AI) is filtered out of the changes panel.
    expect(within(panel).queryByText("HoneyDrunk.AI")).toBeNull();
    // Per-file status code + path render for the dirty repo's two files.
    expect(within(panel).getByText("packages/ui/src/App.tsx")).toBeTruthy();
    expect(within(panel).getByText("notes.md")).toBeTruthy();
    // The header count is the total changed file count across changed repos.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("collapses and expands the changes panel", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    await screen.findByRole("list", { name: "Changed files" });
    // The head button toggles the list (aria-expanded reflects the state).
    const head = screen.getByRole("button", { name: /Changes/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull());

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByRole("list", { name: "Changed files" })).toBeTruthy());
  });

  it("opens a changed file's diff: calls gitDiff and renders the correlated git_diff", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    const panel = await screen.findByRole("list", { name: "Changed files" });
    fireEvent.click(within(panel).getByText("packages/ui/src/App.tsx"));

    // Clicking the changed file requests its diff for that repo root + path.
    await waitFor(() => expect(client.gitDiffCalls.length).toBeGreaterThan(0));
    const lastDiff = client.gitDiffCalls.at(-1);
    expect(lastDiff?.root).toBe("/demo/HoneyHub");
    expect(lastDiff?.path).toBe("packages/ui/src/App.tsx");

    // The viewer switches to diff mode and the mock's git_diff (+1/-1) renders.
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    expect(screen.getByText("packages/ui/src/App.tsx", { selector: ".git-diff-path" })).toBeTruthy();
  });

  it("renders the truncated-diff note when a git_diff is truncated", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    const panel = await screen.findByRole("list", { name: "Changed files" });
    fireEvent.click(within(panel).getByText("packages/ui/src/App.tsx"));

    // Push a truncated git_diff correlated to the pending {root, path}; the note shows.
    client.push({
      kind: "git_diff",
      diff: {
        root: "/demo/HoneyHub",
        path: "packages/ui/src/App.tsx",
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        truncated: true
      }
    });

    await waitFor(() =>
      expect(screen.getByText("Diff truncated (very large change).")).toBeTruthy()
    );
  });

  it("ignores a git_diff that does not match the pending root/path", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    const panel = await screen.findByRole("list", { name: "Changed files" });
    fireEvent.click(within(panel).getByText("packages/ui/src/App.tsx"));
    await waitFor(() => expect(screen.getByLabelText("Diff")).toBeTruthy());

    // A diff for an unrelated file (different path) must not clobber the open diff: the
    // viewer keeps showing the originally-requested file's path.
    client.push({
      kind: "git_diff",
      diff: {
        root: "/demo/HoneyHub",
        path: "some/other/file.ts",
        patch: "@@ -1 +1 @@\n-x\n+y\n",
        truncated: false
      }
    });

    expect(screen.getByText("packages/ui/src/App.tsx", { selector: ".git-diff-path" })).toBeTruthy();
    expect(screen.queryByText("some/other/file.ts", { selector: ".git-diff-path" })).toBeNull();
  });

  it("refreshes the changes panel on an fs_changed event", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    await screen.findByRole("list", { name: "Changed files" });
    const before = client.gitOverviewRoots.length;

    // A host-pushed fs_changed re-fetches the changes panel (and the current folder/file).
    client.push({ kind: "fs_changed", paths: ["/demo/HoneyHub/notes.md"] });

    await waitFor(() => expect(client.gitOverviewRoots.length).toBe(before + 1));
    expect(client.gitOverviewRoots.at(-1)).toBe("/demo");
  });

  it("ignores a git_overview scoped to a different root", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    // Wait for the in-scope panel so we know the subscription is live.
    await screen.findByRole("list", { name: "Changed files" });

    // An overview for a DIFFERENT root (another Browse/Git surface shares the event bus) is
    // ignored: it must not replace this view's overview with its repos.
    client.push({
      kind: "git_overview",
      overview: {
        root: "/somewhere/else",
        repos: [
          {
            root: "/somewhere/else/OtherRepo",
            branch: "main",
            ahead: 0,
            behind: 0,
            files: [
              { path: "elsewhere.txt", status: " M", staged: false, untracked: false }
            ],
            clean: false
          }
        ]
      }
    });

    // The off-scope repo's file never appears; the original in-scope panel is untouched.
    expect(screen.queryByText("elsewhere.txt")).toBeNull();
    const panel = screen.getByRole("list", { name: "Changed files" });
    expect(within(panel).getByText("packages/ui/src/App.tsx")).toBeTruthy();
  });

  it("re-fetches the changes panel when Refresh is clicked inside a folder", async () => {
    const client = new CapturingClient();
    render(
      <BrowseView
        client={client}
        workspaceRoots={["/demo"]}
        defaultWorkspaceRoot="/demo"
        active
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "/demo" }));
    await screen.findByRole("button", { name: "HoneyHub" });
    const beforeOverview = client.gitOverviewRoots.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));

    // Refresh re-reads both the folder and the changes panel (now scoped to /demo).
    await waitFor(() => expect(client.gitOverviewRoots.length).toBeGreaterThan(beforeOverview));
    expect(client.gitOverviewRoots.at(-1)).toBe("/demo");
  });
});
