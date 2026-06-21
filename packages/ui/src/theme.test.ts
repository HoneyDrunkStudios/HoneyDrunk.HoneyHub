import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isThemeId, loadTheme, saveTheme } from "./theme";

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

describe("theme", () => {
  it("validates theme ids", () => {
    expect(isThemeId("honey")).toBe(true);
    expect(isThemeId("matrix")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId(123)).toBe(false);
  });

  it("defaults to honey and round-trips a saved theme", () => {
    expect(loadTheme()).toBe("honey");
    saveTheme("midnight");
    expect(loadTheme()).toBe("midnight");
  });

  it("falls back to honey for a corrupt stored value", () => {
    globalThis.localStorage.setItem("honeyhub.theme.v1", "bogus");
    expect(loadTheme()).toBe("honey");
  });
});
