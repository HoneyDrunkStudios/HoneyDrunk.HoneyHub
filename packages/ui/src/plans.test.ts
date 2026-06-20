import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { getPlan, loadPlans, savePlans, setPlan, type Plans } from "./plans";

const KEY = "honeyhub.plans.v1";

// The test environment's localStorage is read-only (setItem is not a function), so stub a
// fresh in-memory Storage per test to exercise the save/load round-trip properly.
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

describe("plans storage", () => {
  it("round-trips saved plans through load", () => {
    const plans: Plans = {
      "claude.local": { type: "flat", monthlyUsd: 20 },
      "codex.local": { type: "metered" }
    };
    savePlans(plans);
    expect(loadPlans()).toEqual(plans);
  });

  it("returns {} when nothing is stored", () => {
    expect(loadPlans()).toEqual({});
  });

  it("tolerates invalid JSON and non-object shapes", () => {
    globalThis.localStorage?.setItem(KEY, "not json{");
    expect(loadPlans()).toEqual({});
    globalThis.localStorage?.setItem(KEY, JSON.stringify(42));
    expect(loadPlans()).toEqual({});
    globalThis.localStorage?.setItem(KEY, JSON.stringify(null));
    expect(loadPlans()).toEqual({});
  });

  it("drops unknown backends and coerces malformed entries", () => {
    globalThis.localStorage?.setItem(
      KEY,
      JSON.stringify({
        "claude.local": { type: "flat", monthlyUsd: 20 },
        // Unknown backend key — dropped entirely.
        "bogus.backend": { type: "flat" },
        // Unknown plan type → coerced to "unset"; negative amount → dropped.
        "codex.local": { type: "weird", monthlyUsd: -5 }
      })
    );
    const loaded = loadPlans();
    expect(loaded["claude.local"]).toEqual({ type: "flat", monthlyUsd: 20 });
    expect("bogus.backend" in loaded).toBe(false);
    expect(loaded["codex.local"]).toEqual({ type: "unset" });
  });

  it("coerces a non-object plan value to the unset default", () => {
    globalThis.localStorage?.setItem(
      KEY,
      JSON.stringify({ "claude.local": "garbage" })
    );
    expect(loadPlans()["claude.local"]).toEqual({ type: "unset" });
  });
});

describe("getPlan", () => {
  it("defaults to unset for an absent backend", () => {
    expect(getPlan({}, "claude.local")).toEqual({ type: "unset" });
  });

  it("returns the stored plan when present", () => {
    const plans: Plans = { "claude.local": { type: "flat", monthlyUsd: 17 } };
    expect(getPlan(plans, "claude.local")).toEqual({ type: "flat", monthlyUsd: 17 });
  });
});

describe("setPlan", () => {
  it("stores a flat plan and clears an unset one", () => {
    const backend: AgentBackend = "claude.local";
    const withFlat = setPlan({}, backend, { type: "flat", monthlyUsd: 20 });
    expect(withFlat[backend]).toEqual({ type: "flat", monthlyUsd: 20 });

    const cleared = setPlan(withFlat, backend, { type: "unset" });
    expect(backend in cleared).toBe(false);
  });

  it("does not mutate the input map", () => {
    const original: Plans = {};
    setPlan(original, "codex.local", { type: "metered" });
    expect(original).toEqual({});
  });
});
