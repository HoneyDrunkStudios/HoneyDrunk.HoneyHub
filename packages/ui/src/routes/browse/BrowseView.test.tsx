import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { BrowseView } from "./BrowseView";

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
});
