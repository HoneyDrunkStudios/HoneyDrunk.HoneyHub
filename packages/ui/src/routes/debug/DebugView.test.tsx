import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { MockWireClient } from "../../wire/mockClient";
import { DebugView, statusLabel } from "./DebugView";

describe("DebugView", () => {
  it("renders nothing when not the active page", () => {
    const { container } = render(
      <DebugView client={new MockWireClient()} active={false} workspaceRoots={["/repo"]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists host-offered configs and starts a session on Debug", async () => {
    render(<DebugView client={new MockWireClient()} active workspaceRoots={["/repo"]} />);
    expect(screen.getByText(/Not debugging\./i)).toBeTruthy();

    // The config picker populates from the host's dap_configs answer (the mock offers one).
    await waitFor(() => expect(screen.getByRole("option", { name: /App \(net9\.0\)/i })).toBeTruthy());

    // Clicking Debug opens a session; the mock announces dap_session_opened, so the hook adopts it
    // and drives the handshake, reaching "Starting" (the mock runs no real adapter beyond the open).
    fireEvent.click(screen.getByRole("button", { name: /^debug$/i }));
    await waitFor(() => expect(screen.getByText(/Starting the debug session/i)).toBeTruthy());
  });

  it("degrades honestly when the root offers no debug configurations", async () => {
    // A client that answers listDapConfigs with an empty set (no runnable project / no adapter).
    let handler: ((event: BridgeEvent) => void) | undefined;
    const client = {
      subscribe: (h: (event: BridgeEvent) => void) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      },
      listDapConfigs: async (root: string) => {
        handler?.({
          id: "e",
          sessionId: "",
          runId: "",
          sequence: 0,
          createdAt: "",
          payload: { kind: "dap_configs", root, configs: [] }
        });
      },
      openDapSession: async () => {},
      sendDap: async () => {},
      stopDap: async () => {}
    } as unknown as WireClient;

    render(<DebugView client={client} active workspaceRoots={["/repo"]} />);
    await waitFor(() =>
      expect(screen.getByText(/No debug configurations here/i)).toBeTruthy()
    );
    // The Debug button is disabled with no config to launch.
    expect(screen.getByRole("button", { name: /^debug$/i }).hasAttribute("disabled")).toBe(true);
  });

  it("maps status to an honest label", () => {
    expect(statusLabel("denied")).toMatch(/Run is still available/i);
    expect(statusLabel("stopped")).toBe("Stopped.");
  });
});
