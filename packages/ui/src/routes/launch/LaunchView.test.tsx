import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { LaunchView, kindBadge, statusLabel } from "./LaunchView";

describe("LaunchView helpers", () => {
  it("labels every launch status", () => {
    expect(statusLabel("idle", null)).toMatch(/No launch/i);
    expect(statusLabel("starting", null)).toMatch(/Starting/i);
    expect(statusLabel("running", null)).toMatch(/Running/i);
    expect(statusLabel("stopped", "exited")).toMatch(/Stopped \(exited\)/i);
    expect(statusLabel("stopped", null)).toMatch(/Stopped\./i);
    expect(statusLabel("denied", "nope")).toMatch(/did not offer/i);
    expect(statusLabel("error", "boom")).toMatch(/Could not start.*boom/i);
  });

  it("badges every target kind", () => {
    expect(kindBadge("run")).toBe("Run");
    expect(kindBadge("build")).toBe("Build");
    expect(kindBadge("test")).toBe("Test");
    expect(kindBadge("script")).toBe("Script");
  });
});

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
