import { afterEach, describe, expect, it, vi } from "vitest";
import { addProbe, loadJobPatterns, parsePatterns, removeProbe, saveJobPatterns } from "./jobPatterns";

describe("jobPatterns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses comma/newline patterns: trims, lowercases, de-dupes, drops blanks", () => {
    expect(parsePatterns("My-Worker, queue-runner.js , my-worker\n,  ")).toEqual([
      "my-worker",
      "queue-runner.js"
    ]);
    expect(parsePatterns("   ")).toEqual([]);
  });

  it("adds a probe and replaces one with a colliding label (case-insensitive)", () => {
    const one = addProbe([], "My Worker", "my-worker");
    expect(one).toEqual([{ label: "My Worker", patterns: ["my-worker"] }]);
    const replaced = addProbe(one, "my worker", "other-pattern");
    expect(replaced).toEqual([{ label: "my worker", patterns: ["other-pattern"] }]);
  });

  it("refuses to add a probe with an empty label or no usable patterns", () => {
    expect(addProbe([], "", "x")).toEqual([]);
    expect(addProbe([], "Label", "   ")).toEqual([]);
  });

  it("removes a probe by exact label", () => {
    const probes = [
      { label: "A", patterns: ["a"] },
      { label: "B", patterns: ["b"] }
    ];
    expect(removeProbe(probes, "A")).toEqual([{ label: "B", patterns: ["b"] }]);
  });

  it("round-trips through localStorage and tolerates garbled storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    });
    saveJobPatterns([{ label: "Worker", patterns: ["worker"] }]);
    expect(loadJobPatterns()).toEqual([{ label: "Worker", patterns: ["worker"] }]);

    // Garbled / wrong-shaped entries are filtered out, not thrown.
    store.set("honeyhub.jobPatterns.v1", '[{"label":"ok","patterns":["p"]},{"label":""},42]');
    expect(loadJobPatterns()).toEqual([{ label: "ok", patterns: ["p"] }]);

    store.set("honeyhub.jobPatterns.v1", "not json");
    expect(loadJobPatterns()).toEqual([]);
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => saveJobPatterns([{ label: "X", patterns: ["x"] }])).not.toThrow();
    expect(loadJobPatterns()).toEqual([]);
  });
});
