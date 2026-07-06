import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { utf8ToBase64 } from "../../terminal/base64";
import { useTerminalSession } from "./useTerminalSession";

/** A wire double exposing just the terminal seam the hook uses, plus a manual event pump. */
function fakeClient(overrides?: Partial<WireClient>): {
  client: WireClient;
  calls: {
    open: Array<{ root: string; cols: number; rows: number; openId: string }>;
    input: Array<{ sessionId: string; data: string }>;
    resize: Array<{ sessionId: string; cols: number; rows: number }>;
    close: string[];
  };
  emit: (payload: BridgeEventPayload) => void;
} {
  let handler: ((event: BridgeEvent) => void) | undefined;
  const calls = {
    open: [] as Array<{ root: string; cols: number; rows: number; openId: string }>,
    input: [] as Array<{ sessionId: string; data: string }>,
    resize: [] as Array<{ sessionId: string; cols: number; rows: number }>,
    close: [] as string[]
  };
  const client = {
    subscribe: (h: (event: BridgeEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    openTerminal: async (root: string, cols: number, rows: number, openId: string) => {
      calls.open.push({ root, cols, rows, openId });
    },
    sendTerminalInput: async (sessionId: string, data: string) => {
      calls.input.push({ sessionId, data });
    },
    resizeTerminal: async (sessionId: string, cols: number, rows: number) => {
      calls.resize.push({ sessionId, cols, rows });
    },
    closeTerminal: async (sessionId: string) => {
      calls.close.push(sessionId);
    },
    ...overrides
  } as unknown as WireClient;
  return {
    client,
    calls,
    emit: (payload) =>
      handler?.({
        id: "e",
        sessionId: "",
        runId: "",
        sequence: 0,
        createdAt: "",
        payload
      })
  };
}

describe("useTerminalSession", () => {
  it("opens, adopts the session, streams output, sends input, and closes", async () => {
    const { client, calls, emit } = fakeClient();
    const output: Uint8Array[] = [];
    const { result } = renderHook(() =>
      useTerminalSession(client, (bytes) => output.push(bytes))
    );

    expect(result.current.status).toBe("idle");

    await act(async () => {
      result.current.open("/repo", 80, 24);
    });
    expect(result.current.status).toBe("opening");
    expect(calls.open).toHaveLength(1);
    expect(calls.open[0]).toMatchObject({ root: "/repo", cols: 80, rows: 24 });
    const openId = calls.open[0]!.openId;
    expect(typeof openId).toBe("string");

    // A terminal_opened for a DIFFERENT open (another cockpit) must not be adopted.
    act(() => emit({ kind: "terminal_opened", sessionId: "other", openId: "someone-else" }));
    expect(result.current.status).toBe("opening");
    expect(result.current.sessionId).toBeNull();

    // The host answers OUR open (matching nonce) with the session id.
    act(() => emit({ kind: "terminal_opened", sessionId: "t1", openId }));
    expect(result.current.status).toBe("open");
    expect(result.current.sessionId).toBe("t1");

    // Output for our session is decoded and delivered.
    act(() => emit({ kind: "terminal_output", sessionId: "t1", data: utf8ToBase64("hi") }));
    expect(output).toHaveLength(1);
    expect(new TextDecoder().decode(output[0])).toBe("hi");

    // Output for a different session is ignored.
    act(() => emit({ kind: "terminal_output", sessionId: "other", data: utf8ToBase64("no") }));
    expect(output).toHaveLength(1);

    await act(async () => {
      result.current.sendInput(utf8ToBase64("x"));
    });
    expect(calls.input).toEqual([{ sessionId: "t1", data: utf8ToBase64("x") }]);

    await act(async () => {
      result.current.close();
    });
    expect(calls.close).toEqual(["t1"]);

    // The host confirms the close.
    act(() => emit({ kind: "terminal_closed", sessionId: "t1", reason: "closed" }));
    expect(result.current.status).toBe("closed");
    expect(result.current.detail).toBe("closed");
  });

  it("does not open twice while one is in flight", async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useTerminalSession(client, () => {}));
    await act(async () => {
      result.current.open("/repo", 80, 24);
      result.current.open("/repo", 80, 24);
    });
    expect(calls.open).toHaveLength(1);
  });

  it("surfaces a relay denial as denied status", async () => {
    const { client } = fakeClient({
      openTerminal: vi.fn().mockRejectedValue({
        code: "terminal_denied",
        message: "desktop-local-only"
      })
    });
    const { result } = renderHook(() => useTerminalSession(client, () => {}));
    await act(async () => {
      result.current.open("/repo", 80, 24);
    });
    expect(result.current.status).toBe("denied");
    expect(result.current.detail).toBe("desktop-local-only");
  });

  it("surfaces a non-denial rejection as an error status", async () => {
    const { client } = fakeClient({
      openTerminal: vi.fn().mockRejectedValue({
        code: "terminal_open_failed",
        message: "no pty"
      })
    });
    const { result } = renderHook(() => useTerminalSession(client, () => {}));
    await act(async () => {
      result.current.open("/repo", 80, 24);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.detail).toBe("no pty");
  });
});
