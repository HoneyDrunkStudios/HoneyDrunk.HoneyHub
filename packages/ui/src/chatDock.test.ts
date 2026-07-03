import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DOCK_DEFAULT_WIDTH,
  CHAT_DOCK_MAX_WIDTH,
  CHAT_DOCK_MIN_WIDTH,
  clampChatDockWidth,
  loadChatDockWidth,
  saveChatDockWidth
} from "./chatDock";

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

describe("chat dock width", () => {
  it("clamps into the allowed range", () => {
    expect(clampChatDockWidth(100)).toBe(CHAT_DOCK_MIN_WIDTH);
    expect(clampChatDockWidth(5000)).toBe(CHAT_DOCK_MAX_WIDTH);
    expect(clampChatDockWidth(400.6)).toBe(401);
  });

  it("round-trips through storage, clamped", () => {
    saveChatDockWidth(9999);
    expect(loadChatDockWidth()).toBe(CHAT_DOCK_MAX_WIDTH);
    saveChatDockWidth(420);
    expect(loadChatDockWidth()).toBe(420);
  });

  it("falls back to the default on absent or garbled storage", () => {
    expect(loadChatDockWidth()).toBe(CHAT_DOCK_DEFAULT_WIDTH);
    globalThis.localStorage?.setItem("honeyhub.chatDockWidth.v1", "not a number");
    expect(loadChatDockWidth()).toBe(CHAT_DOCK_DEFAULT_WIDTH);
    vi.stubGlobal("localStorage", undefined);
    expect(loadChatDockWidth()).toBe(CHAT_DOCK_DEFAULT_WIDTH);
    expect(() => saveChatDockWidth(400)).not.toThrow();
  });
});
