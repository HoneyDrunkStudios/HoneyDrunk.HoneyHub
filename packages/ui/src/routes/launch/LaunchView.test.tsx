import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { LaunchView } from "./LaunchView";

describe("LaunchView", () => {
  it("prompts to add a root when the allowlist is empty", () => {
    render(<LaunchView client={new MockWireClient()} active workspaceRoots={[]} />);
    expect(screen.getByText(/Add a workspace root in Settings/i)).toBeTruthy();
  });

  it("renders nothing when not the active page", () => {
    const { container } = render(
      <LaunchView client={new MockWireClient()} active={false} workspaceRoots={["/repo"]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("detects targets, starts one, streams its log, and stops it", async () => {
    render(<LaunchView client={new MockWireClient()} active workspaceRoots={["/repo"]} />);

    // The mock detects two targets on mount.
    const runButton = await screen.findByRole("button", { name: /npm run dev/i });
    expect(runButton).toBeTruthy();

    fireEvent.click(runButton);

    // The mock echoes a launch log; the panel shows it and a Stop control appears.
    await waitFor(() => expect(screen.getByText(/launching node:dev/i)).toBeTruthy());
    const stop = screen.getByRole("button", { name: /^stop$/i });
    expect(screen.getByText(/Running\./i)).toBeTruthy();

    fireEvent.click(stop);
    await waitFor(() => expect(screen.getByText(/Stopped/i)).toBeTruthy());
  });
});
