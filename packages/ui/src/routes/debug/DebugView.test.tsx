import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("drives a session to stopped, renders the call stack, and steps then stops", async () => {
    // A scripted wire double: it offers one config, opens a session, and answers the DAP handshake
    // like a real adapter would (initialize -> launch -> initialized + stopped -> stackTrace), so
    // the live / stopped controls and the call-stack panel render.
    // DebugView has two subscribers (the session hook and the config-list effect), so the double
    // must fan out to all of them, like the real client.
    const handlers = new Set<(event: BridgeEvent) => void>();
    const emit = (payload: BridgeEvent["payload"]) => {
      const event: BridgeEvent = { id: "e", sessionId: "", runId: "", sequence: 0, createdAt: "", payload };
      for (const h of [...handlers]) {
        h(event);
      }
    };
    let seq = 0;
    const client = {
      subscribe: (h: (event: BridgeEvent) => void) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      listDapConfigs: async (root: string) => {
        emit({
          kind: "dap_configs",
          root,
          configs: [{ configId: "dotnet:App", label: "App (net9.0)", language: "csharp", adapterId: "netcoredbg" }]
        });
      },
      openDapSession: async (_root: string, adapterId: string, _configId: string, openId: string) => {
        emit({ kind: "dap_session_opened", sessionId: "d1", adapterId, openId });
      },
      sendDap: async (sid: string, message: unknown) => {
        const m = message as { command?: string; seq?: number };
        seq += 1;
        const respond = (body?: Record<string, unknown>) =>
          emit({ kind: "dap_message", sessionId: sid, message: { type: "response", request_seq: m.seq, command: m.command, success: true, ...(body ? { body } : {}) } });
        if (m.command === "initialize") {
          respond();
        } else if (m.command === "launch") {
          emit({ kind: "dap_message", sessionId: sid, message: { type: "event", event: "initialized" } });
          emit({ kind: "dap_message", sessionId: sid, message: { type: "event", event: "stopped", body: { reason: "entry", threadId: 1 } } });
          respond();
        } else if (m.command === "stackTrace") {
          respond({ stackFrames: [{ id: 3, name: "Main", line: 5, column: 1, source: { path: "/repo/Program.cs" } }] });
        } else if (m.command === "continue") {
          emit({ kind: "dap_message", sessionId: sid, message: { type: "event", event: "continued", body: {} } });
        }
      },
      stopDap: async (sid: string) => {
        emit({ kind: "dap_session_closed", sessionId: sid, reason: "operator_closed" });
      }
    } as unknown as WireClient;

    render(<DebugView client={client} active workspaceRoots={["/repo"]} />);
    await waitFor(() => expect(screen.getByRole("option", { name: /App \(net9\.0\)/i })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^debug$/i }));
    });

    // The debuggee stops at entry: the call stack renders and the step / stop controls appear.
    await waitFor(() => expect(screen.getByText(/^Stopped\.$/i)).toBeTruthy());
    expect(screen.getByText(/Main/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /step over/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    });
    await waitFor(() => expect(screen.getByText(/Debug session ended\./i)).toBeTruthy());
  });

  it("maps status to an honest label", () => {
    expect(statusLabel("denied")).toMatch(/Run is still available/i);
    expect(statusLabel("stopped")).toBe("Stopped.");
  });
});
