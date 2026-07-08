import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { DebugView, statusLabel } from "./DebugView";

describe("DebugView", () => {
  it("renders nothing when not the active page", () => {
    const { container } = render(
      <DebugView client={new MockWireClient()} active={false} workspaceRoots={["/repo"]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("starts a debug session, adopts it, stops at entry, and shows the call stack", async () => {
    render(<DebugView client={new MockWireClient()} active workspaceRoots={["/repo"]} />);
    expect(screen.getByText(/Not debugging\./i)).toBeTruthy();

    // The mock opens a fake session that immediately stops at entry and answers stackTrace.
    fireEvent.click(screen.getByRole("button", { name: /^debug$/i }));
    await waitFor(() => expect(screen.getByText(/^Stopped\.$/i)).toBeTruthy());

    // The call-stack panel shows the frame the mock returned, and the step / stop controls appear.
    expect(screen.getByText(/Main/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeTruthy();
    const stop = screen.getByRole("button", { name: /^stop$/i });

    fireEvent.click(stop);
    await waitFor(() => expect(screen.getByText(/Debug session ended\./i)).toBeTruthy());
  });

  it("maps status to an honest label", () => {
    expect(statusLabel("denied")).toMatch(/Run is still available/i);
    expect(statusLabel("stopped")).toBe("Stopped.");
  });
});
