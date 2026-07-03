import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "@honeydrunk/honeyhub-types";
import {
  applyCheckOutcome,
  checkIdFor,
  DEFAULT_CHECK_ID,
  KNOWN_CHECKS,
  loadCheckIds,
  saveCheckIds,
  setCheckId,
  startCheck,
  summarizeChecks,
  type ChecksState
} from "./checksModel";

function outcome(root: string, ok: boolean, over: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    root,
    check: "npm-test",
    command: "npm test",
    ok,
    disposition: "ran",
    output: ok ? "ok" : "boom",
    truncated: false,
    ...over
  };
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

describe("check selection", () => {
  it("falls back to the default when a repo has no pick", () => {
    expect(checkIdFor({}, "/a")).toBe(DEFAULT_CHECK_ID);
    expect(checkIdFor({ "/a": "cargo-test" }, "/a")).toBe("cargo-test");
  });

  it("sets and clears a per-repo pick (default id clears the override)", () => {
    const set = setCheckId({}, "/a", "cargo-test");
    expect(set["/a"]).toBe("cargo-test");
    expect(setCheckId(set, "/a", DEFAULT_CHECK_ID)["/a"]).toBeUndefined();
  });

  it("offers only named checks (no free command lines)", () => {
    expect(KNOWN_CHECKS.length).toBeGreaterThan(0);
    expect(KNOWN_CHECKS.some((check) => check.id === DEFAULT_CHECK_ID)).toBe(true);
    for (const check of KNOWN_CHECKS) {
      expect(check.id).not.toContain(" ");
    }
  });
});

describe("persistence", () => {
  it("round-trips known ids and tolerates garbage", () => {
    saveCheckIds({ "/a": "cargo-test", "/b": "pytest" });
    expect(loadCheckIds()).toEqual({ "/a": "cargo-test", "/b": "pytest" });

    globalThis.localStorage?.setItem("honeyhub.groupChecks.v2", "not json");
    expect(loadCheckIds()).toEqual({});

    globalThis.localStorage?.setItem("honeyhub.groupChecks.v2", JSON.stringify(["nope"]));
    expect(loadCheckIds()).toEqual({});
  });

  it("drops unknown ids and non-string values, mapping recognizable command lines", () => {
    globalThis.localStorage?.setItem(
      "honeyhub.groupChecks.v2",
      JSON.stringify({ "/a": "cargo-test", "/b": "npm test", "/c": 42, "/d": "evil; rm -rf" })
    );
    // "npm test" maps onto its named check; garbage is dropped.
    expect(loadCheckIds()).toEqual({ "/a": "cargo-test", "/b": "npm-test" });
  });

  it("migrates v1 free-text commands to named checks once, then removes the old key", () => {
    globalThis.localStorage?.setItem(
      "honeyhub.groupChecks.v1",
      JSON.stringify({ "/rust": "cargo test --workspace", "/py": "pytest", "/odd": "./run.sh" })
    );
    expect(loadCheckIds()).toEqual({ "/rust": "cargo-test", "/py": "pytest" });
    expect(globalThis.localStorage?.getItem("honeyhub.groupChecks.v1")).toBeNull();
    expect(globalThis.localStorage?.getItem("honeyhub.groupChecks.v2")).not.toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveCheckIds({ "/a": "cargo-test" })).not.toThrow();
    expect(loadCheckIds()).toEqual({});
  });
});

describe("run state", () => {
  it("starts a check as running then folds its outcome", () => {
    let state: ChecksState = startCheck({}, { root: "/a", command: "npm-test" });
    expect(state["/a"]!.phase).toBe("running");

    state = applyCheckOutcome(state, outcome("/a", true, { exitCode: 0 }));
    expect(state["/a"]!.phase).toBe("passed");
    expect(state["/a"]!.output).toBe("ok");
    expect(state["/a"]!.exitCode).toBe(0);

    state = applyCheckOutcome(state, outcome("/a", false, { exitCode: 1, truncated: true }));
    expect(state["/a"]!.phase).toBe("failed");
    expect(state["/a"]!.truncated).toBe(true);
  });

  it("folds refusals (denied / timed out) as failures with the reason", () => {
    const state = applyCheckOutcome(
      {},
      outcome("/a", false, { disposition: "denied", output: "not an allowed check" })
    );
    expect(state["/a"]!.phase).toBe("failed");
    expect(state["/a"]!.output).toBe("not an allowed check");
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
