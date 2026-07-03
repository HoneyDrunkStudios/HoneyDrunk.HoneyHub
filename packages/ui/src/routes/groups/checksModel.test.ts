import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "@honeydrunk/honeyhub-types";
import {
  applyCheckOutcome,
  checkIdFor,
  DEFAULT_CHECK_ID,
  KNOWN_CHECK_IDS,
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

  it("offers only named check ids (no free command lines)", () => {
    expect(KNOWN_CHECK_IDS.length).toBeGreaterThan(0);
    expect(KNOWN_CHECK_IDS).toContain(DEFAULT_CHECK_ID);
    for (const id of KNOWN_CHECK_IDS) {
      expect(id).not.toContain(" ");
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

  it("keeps a running pill through an OVERLAP denial (the real outcome is still coming)", () => {
    const running = startCheck({}, { root: "/a", command: "npm-test" });
    const state = applyCheckOutcome(
      running,
      outcome("/a", false, {
        disposition: "denied",
        denial: "overlap",
        output: "a check is already running in this repo"
      })
    );
    expect(state).toBe(running);
    expect(state["/a"]!.phase).toBe("running");
  });

  it("recognizes an overlap denial from an old host by message when the typed code is absent", () => {
    const running = startCheck({}, { root: "/a", command: "npm-test" });
    const state = applyCheckOutcome(
      running,
      outcome("/a", false, {
        disposition: "denied",
        output: "a check is already running in this repo"
      })
    );
    expect(state).toBe(running);
  });

  it("lands a NON-overlap denial of a running check as failed (it is the final answer)", () => {
    const running = startCheck({}, { root: "/a", command: "nope-check" });
    const state = applyCheckOutcome(
      running,
      outcome("/a", false, {
        disposition: "denied",
        denial: "unknown_check",
        output: "`nope-check` is not an allowed check"
      })
    );
    expect(state["/a"]!.phase).toBe("failed");
    expect(state["/a"]!.output).toContain("not an allowed check");
  });

  it("trusts the typed denial code over the message text when both are present", () => {
    const running = startCheck({}, { root: "/a", command: "npm-test" });
    // A message that HAPPENS to mention the overlap phrase must not resurrect the
    // substring heuristic once the host speaks the typed code.
    const state = applyCheckOutcome(
      running,
      outcome("/a", false, {
        disposition: "denied",
        denial: "task_failed",
        output: "task failed while a check is already running elsewhere"
      })
    );
    expect(state["/a"]!.phase).toBe("failed");
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
