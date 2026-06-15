import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecord } from "./chatHistory";
import { getChat, loadChatSummaries, loadChats, saveChat } from "./chatHistory";

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

function record(id: string, updatedAt: string, over: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id,
    task: `task ${id}`,
    state: "completed",
    messages: [
      {
        id: `m-${id}`,
        sessionId: "s",
        runId: id,
        role: "agent",
        body: "hello",
        createdAt: updatedAt
      }
    ],
    totalUsd: 0.01,
    totalTokens: 100,
    createdAt: updatedAt,
    updatedAt,
    ...over
  };
}

describe("chatHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and loads a chat round-trip", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z"));
    const chats = loadChats();
    expect(chats).toHaveLength(1);
    expect(chats[0]!.id).toBe("a");
    expect(getChat("a")?.messages[0]!.body).toBe("hello");
    expect(getChat("missing")).toBeUndefined();
  });

  it("updates an existing chat by id instead of duplicating", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z"));
    saveChat(record("a", "2026-06-14T02:00:00Z", { task: "updated" }));
    const chats = loadChats();
    expect(chats).toHaveLength(1);
    expect(chats[0]!.task).toBe("updated");
  });

  it("returns summaries newest-first without transcripts", () => {
    saveChat(record("old", "2026-06-14T01:00:00Z"));
    saveChat(record("new", "2026-06-14T03:00:00Z"));
    saveChat(record("mid", "2026-06-14T02:00:00Z"));
    const summaries = loadChatSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["new", "mid", "old"]);
    // Summaries omit the (potentially large) transcript.
    expect("messages" in summaries[0]!).toBe(false);
  });

  it("caps stored chats to the most recent 100", () => {
    for (let i = 0; i < 105; i += 1) {
      // Zero-padded millis so lexicographic updatedAt order matches numeric order.
      const stamp = `2026-06-14T00:00:00.${String(i).padStart(3, "0")}Z`;
      saveChat(record(`c${String(i).padStart(3, "0")}`, stamp));
    }
    const chats = loadChats();
    expect(chats).toHaveLength(100);
    // The newest survives; the 5 oldest were trimmed.
    expect(chats[0]!.id).toBe("c104");
    expect(chats.some((c) => c.id === "c000")).toBe(false);
  });

  it("returns an empty list for malformed or missing storage", () => {
    expect(loadChats()).toEqual([]);
    localStorage.setItem("honeyhub.chats.v1", "not json");
    expect(loadChats()).toEqual([]);
    localStorage.setItem("honeyhub.chats.v1", JSON.stringify({ not: "an array" }));
    expect(loadChats()).toEqual([]);
  });
});
