import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "@honeydrunk/honeyhub-types";
import {
  applyCheckOutcome,
  checkCommandFor,
  DEFAULT_CHECK_COMMAND,
  loadCheckCommands,
  saveCheckCommands,
  setCheckCommand,
  startCheck,
  summarizeChecks,
  type ChecksState
} from "./checksModel";

function outcome(root: string, ok: boolean, over: Partial<CheckOutcome> = {}): CheckOutcome {
  return { root, command: "npm test", ok, output: ok ? "ok" : "boom", truncated: false, ...over };
}

// The runtime's localStorage varies by Node version (absent without --localstorage-file on
// newer Nodes), so stub a fresh in-memory Storage per test, like chatHistory.test.ts does.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command selection", () => {
  it("falls back to the default for unknown or blank entries", () => {
    expect(checkCommandFor({}, "/a")).toBe(DEFAULT_CHECK_COMMAND);
    expect(checkCommandFor({ "/a": "   " }, "/a")).toBe(DEFAULT_CHECK_COMMAND);
    expect(checkCommandFor({ "/a": "cargo test" }, "/a")).toBe("cargo test");
  });

  it("sets and clears a per-repo command", () => {
    const set = setCheckCommand({}, "/a", "cargo test");
    expect(set["/a"]).toBe("cargo test");
    const cleared = setCheckCommand(set, "/a", "  ");
    expect(cleared["/a"]).toBeUndefined();
  });
});

describe("persistence", () => {
  it("round-trips through storage and tolerates garbage", () => {
    saveCheckCommands({ "/a": "cargo test", "/b": "npm run ci" });
    expect(loadCheckCommands()).toEqual({ "/a": "cargo test", "/b": "npm run ci" });

    globalThis.localStorage?.setItem("honeyhub.groupChecks.v1", "not json");
    expect(loadCheckCommands()).toEqual({});

    globalThis.localStorage?.setItem("honeyhub.groupChecks.v1", JSON.stringify(["nope"]));
    expect(loadCheckCommands()).toEqual({});
  });

  it("drops non-string command values", () => {
    globalThis.localStorage?.setItem(
      "honeyhub.groupChecks.v1",
      JSON.stringify({ "/a": "npm test", "/b": 42 })
    );
    expect(loadCheckCommands()).toEqual({ "/a": "npm test" });
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveCheckCommands({ "/a": "npm test" })).not.toThrow();
    expect(loadCheckCommands()).toEqual({});
  });
});

describe("run state", () => {
  it("starts a check as running then folds its outcome", () => {
    let state: ChecksState = startCheck({}, { root: "/a", command: "npm test" });
    expect(state["/a"]!.phase).toBe("running");

    state = applyCheckOutcome(state, outcome("/a", true, { exitCode: 0 }));
    expect(state["/a"]!.phase).toBe("passed");
    expect(state["/a"]!.output).toBe("ok");
    expect(state["/a"]!.exitCode).toBe(0);

    state = applyCheckOutcome(state, outcome("/a", false, { exitCode: 1, truncated: true }));
    expect(state["/a"]!.phase).toBe("failed");
    expect(state["/a"]!.truncated).toBe(true);
  });

  it("records an outcome for a repo we never started", () => {
    const state = applyCheckOutcome({}, outcome("/z", true));
    expect(state["/z"]!.phase).toBe("passed");
  });

  it("summarizes a set of check states", () => {
    const state: ChecksState = applyCheckOutcome(
      applyCheckOutcome(startCheck({}, { root: "/c", command: "x" }), outcome("/a", true)),
      outcome("/b", false)
    );
    expect(summarizeChecks(Object.values(state))).toEqual({
      running: 1,
      passed: 1,
      failed: 1,
      total: 3
    });
  });
});
