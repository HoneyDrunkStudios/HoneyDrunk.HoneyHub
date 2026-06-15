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
    await waitFor(() => expect(screen.getByText("HoneyHub")).toBeTruthy());
    const afterOpen = browseCalls;

    // The Refresh button appears once inside a folder; clicking re-reads the same path.
    fireEvent.click(screen.getByRole("button", { name: "Refresh folder" }));
    await waitFor(() => expect(browseCalls).toBe(afterOpen + 1));
  });

  it("shows no Refresh button at the locations (top) level", () => {
    render(<BrowseView client={new MockWireClient()} workspaceRoots={["/demo"]} active />);
    expect(screen.queryByRole("button", { name: "Refresh folder" })).toBeNull();
  });
});
