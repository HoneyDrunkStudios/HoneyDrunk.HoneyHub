import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { bytesToBase64, utf8ToBase64 } from "../../wire/base64";
import { useLaunchSession } from "./useLaunchSession";

/** A wire double exposing just the launch seam the hook uses, plus a manual event pump. */
function fakeClient(overrides?: Partial<WireClient>): {
  client: WireClient;
  calls: {
    start: Array<{ root: string; targetId: string; openId: string }>;
    stop: string[];
  };
  emit: (payload: BridgeEventPayload) => void;
} {
  let handler: ((event: BridgeEvent) => void) | undefined;
  const calls = {
    start: [] as Array<{ root: string; targetId: string; openId: string }>,
    stop: [] as string[]
  };
  const client = {
    subscribe: (h: (event: BridgeEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    startLaunch: async (root: string, targetId: string, openId: string) => {
      calls.start.push({ root, targetId, openId });
    },
    stopLaunch: async (launchId: string) => {
      calls.stop.push(launchId);
    },
    ...overrides
  } as unknown as WireClient;
  return {
    client,
    calls,
    emit: (payload) =>
      handler?.({ id: "e", sessionId: "", runId: "", sequence: 0, createdAt: "", payload })
  };
}

describe("useLaunchSession", () => {
  it("starts, adopts by nonce, streams output, and stops", async () => {
    const { client, calls, emit } = fakeClient();
    const output: string[] = [];
    const { result } = renderHook(() => useLaunchSession(client, (text) => output.push(text)));

    expect(result.current.status).toBe("idle");
    await act(async () => {
      result.current.start("/repo", "cargo:run");
    });
    expect(result.current.status).toBe("starting");
    expect(calls.start).toHaveLength(1);
    const openId = calls.start[0]!.openId;

    // A launch_started for another cockpit's launch must not be adopted.
    act(() => emit({ kind: "launch_started", launchId: "other", targetId: "x", openId: "nope" }));
    expect(result.current.status).toBe("starting");
    expect(result.current.launchId).toBeNull();

    // Our launch (matching nonce) is adopted.
    act(() =>
      emit({ kind: "launch_started", launchId: "l1", targetId: "cargo:run", openId })
    );
    expect(result.current.status).toBe("running");
    expect(result.current.launchId).toBe("l1");

    // Output for our launch is decoded and delivered; another launch's is ignored.
    act(() => emit({ kind: "launch_output", launchId: "l1", stream: "stdout", data: utf8ToBase64("hi") }));
    act(() => emit({ kind: "launch_output", launchId: "zzz", stream: "stdout", data: utf8ToBase64("no") }));
    expect(output).toEqual(["hi"]);

    await act(async () => {
      result.current.stop();
    });
    expect(calls.stop).toEqual(["l1"]);

    act(() => emit({ kind: "launch_stopped", launchId: "l1", reason: "stopped" }));
    expect(result.current.status).toBe("stopped");
    expect(result.current.detail).toBe("stopped");
  });

  it("reassembles a multibyte UTF-8 char split across two output chunks", async () => {
    const { client, calls, emit } = fakeClient();
    const output: string[] = [];
    const { result } = renderHook(() => useLaunchSession(client, (text) => output.push(text)));
    await act(async () => {
      result.current.start("/repo", "cargo:run");
    });
    const openId = calls.start[0]!.openId;
    act(() => emit({ kind: "launch_started", launchId: "l1", targetId: "t", openId }));

    // The rocket emoji is four UTF-8 bytes (F0 9F 9A 80); split it across two chunks. A fresh
    // per-chunk decoder would emit replacement chars, but the streaming decoder reassembles it.
    const rocket = new TextEncoder().encode("\u{1f680}");
    act(() =>
      emit({ kind: "launch_output", launchId: "l1", stream: "stdout", data: bytesToBase64(rocket.slice(0, 2)) })
    );
    act(() =>
      emit({ kind: "launch_output", launchId: "l1", stream: "stdout", data: bytesToBase64(rocket.slice(2)) })
    );
    expect(output.join("")).toBe("\u{1f680}");
  });

  it("does not start twice while one is in flight", async () => {
    const { client, calls } = fakeClient();
    const { result } = renderHook(() => useLaunchSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "cargo:run");
      result.current.start("/repo", "cargo:run");
    });
    expect(calls.start).toHaveLength(1);
  });

  it("surfaces a host denial of an unknown target", async () => {
    const { client } = fakeClient({
      startLaunch: vi.fn().mockRejectedValue({ code: "launch_denied", message: "no such target" })
    });
    const { result } = renderHook(() => useLaunchSession(client, () => {}));
    await act(async () => {
      result.current.start("/repo", "cargo:publish");
    });
    expect(result.current.status).toBe("denied");
    expect(result.current.detail).toBe("no such target");
  });
});
