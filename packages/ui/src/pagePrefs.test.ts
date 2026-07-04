import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HIDDEN_PAGES,
  isPageVisible,
  loadPagePrefs,
  savePagePrefs,
  TOGGLEABLE_PAGES
} from "./pagePrefs";

describe("pagePrefs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a normal page by default", () => {
    expect(isPageVisible({}, "repositories")).toBe(true);
    expect(isPageVisible({}, "spend")).toBe(true);
  });

  it("hides runs and goals by default", () => {
    for (const view of DEFAULT_HIDDEN_PAGES) {
      expect(isPageVisible({}, view)).toBe(false);
    }
    expect(isPageVisible({}, "runs")).toBe(false);
    expect(isPageVisible({}, "goals")).toBe(false);
  });

  it("respects an explicit false on a normally-visible page", () => {
    expect(isPageVisible({ repositories: false }, "repositories")).toBe(false);
  });

  it("respects an explicit true on a default-hidden page", () => {
    expect(isPageVisible({ runs: true }, "runs")).toBe(true);
    expect(isPageVisible({ goals: true }, "goals")).toBe(true);
  });

  it("lists the expected toggleable pages without core pages", () => {
    const views = TOGGLEABLE_PAGES.map((page) => page.view);
    expect(views).toContain("runs");
    expect(views).toContain("goals");
    expect(views).toContain("repositories");
    for (const core of ["hub", "run", "settings", "updates", "notifications"]) {
      expect(views).not.toContain(core);
    }
  });

  it("round-trips prefs and ignores non-boolean / garbled storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    });
    savePagePrefs({ runs: true, spend: false });
    expect(loadPagePrefs()).toEqual({ runs: true, spend: false });

    // Only boolean values survive; everything else is dropped.
    store.set("honeyhub.pagePrefs.v1", '{"runs":true,"goals":"yes","work":3}');
    expect(loadPagePrefs()).toEqual({ runs: true });

    store.set("honeyhub.pagePrefs.v1", "not json");
    expect(loadPagePrefs()).toEqual({});
  });

  it("falls back safely when storage is missing", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadPagePrefs()).toEqual({});
    // Best-effort save must not throw when storage is unavailable.
    expect(() => savePagePrefs({ runs: true })).not.toThrow();
  });
});
