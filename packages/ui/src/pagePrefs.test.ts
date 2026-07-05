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

  it("has no default-hidden pages (every toggleable page defaults visible)", () => {
    expect(DEFAULT_HIDDEN_PAGES).toEqual([]);
    for (const page of TOGGLEABLE_PAGES) {
      expect(isPageVisible({}, page.view)).toBe(true);
    }
  });

  it("respects an explicit false on a normally-visible page", () => {
    expect(isPageVisible({ repositories: false }, "repositories")).toBe(false);
  });

  it("honors an explicit true", () => {
    expect(isPageVisible({ groups: true }, "groups")).toBe(true);
  });

  it("lists the expected toggleable pages without core or removed pages", () => {
    const views = TOGGLEABLE_PAGES.map((page) => page.view);
    expect(views).toContain("groups");
    expect(views).toContain("repositories");
    // Runs and Goals were removed entirely (driven from chat instead).
    expect(views).not.toContain("runs");
    expect(views).not.toContain("goals");
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
    savePagePrefs({ groups: true, spend: false });
    expect(loadPagePrefs()).toEqual({ groups: true, spend: false });

    // Only boolean values survive; everything else is dropped.
    store.set("honeyhub.pagePrefs.v1", '{"groups":true,"observe":"yes","work":3}');
    expect(loadPagePrefs()).toEqual({ groups: true });

    store.set("honeyhub.pagePrefs.v1", "not json");
    expect(loadPagePrefs()).toEqual({});
  });

  it("falls back safely when storage is missing", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadPagePrefs()).toEqual({});
    // Best-effort save must not throw when storage is unavailable.
    expect(() => savePagePrefs({ groups: true })).not.toThrow();
  });
});
