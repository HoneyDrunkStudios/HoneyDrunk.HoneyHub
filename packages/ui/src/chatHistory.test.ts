import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecord } from "./chatHistory";
import {
  chatTitle,
  deleteChat,
  getChat,
  loadChatSummaries,
  loadChats,
  renameChat,
  saveChat,
  searchChatSummaries,
  setChatPinned
} from "./chatHistory";

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

  it("renames a chat (title wins over task; empty rename clears back to the task)", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z"));
    renameChat("a", "  Vault connector planning  ");
    expect(getChat("a")?.title).toBe("Vault connector planning");
    expect(chatTitle(getChat("a")!)).toBe("Vault connector planning");
    renameChat("a", "   ");
    expect(getChat("a")?.title).toBeUndefined();
    expect(chatTitle(getChat("a")!)).toBe("task a");
  });

  it("deletes a chat", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z"));
    saveChat(record("b", "2026-06-14T02:00:00Z"));
    deleteChat("a");
    expect(loadChats().map((chat) => chat.id)).toEqual(["b"]);
  });

  it("pins a chat above newer ones and unpins it back", () => {
    saveChat(record("old", "2026-06-14T01:00:00Z"));
    saveChat(record("new", "2026-06-14T03:00:00Z"));
    setChatPinned("old", true);
    expect(loadChatSummaries().map((chat) => chat.id)).toEqual(["old", "new"]);
    setChatPinned("old", false);
    expect(loadChatSummaries().map((chat) => chat.id)).toEqual(["new", "old"]);
  });

  it("keeps a rename and a pin through a live-run saveChat that carries neither", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z"));
    renameChat("a", "My thread");
    setChatPinned("a", true);
    // The run saver rebuilds records from run state, without title/pinned.
    saveChat(record("a", "2026-06-14T02:00:00Z", { task: "updated task" }));
    const chat = getChat("a");
    expect(chat?.title).toBe("My thread");
    expect(chat?.pinned).toBe(true);
    expect(chat?.task).toBe("updated task");
  });

  it("protects pinned chats from the storage cap", () => {
    saveChat(record("keeper", "2026-06-14T00:00:00.000Z"));
    setChatPinned("keeper", true);
    for (let i = 1; i <= 104; i += 1) {
      const stamp = `2026-06-14T00:00:00.${String(i).padStart(3, "0")}Z`;
      saveChat(record(`c${String(i).padStart(3, "0")}`, stamp));
    }
    const chats = loadChats();
    expect(chats).toHaveLength(100);
    expect(chats.some((chat) => chat.id === "keeper")).toBe(true);
  });

  it("searches by title and task, case-insensitively", () => {
    saveChat(record("a", "2026-06-14T01:00:00Z", { task: "fix the vault rotation" }));
    saveChat(record("b", "2026-06-14T02:00:00Z", { task: "write blog post" }));
    renameChat("b", "Distribution");
    const summaries = loadChatSummaries();
    expect(searchChatSummaries(summaries, "VAULT").map((chat) => chat.id)).toEqual(["a"]);
    // A renamed chat matches its new title AND its original task text.
    expect(searchChatSummaries(summaries, "distribution").map((chat) => chat.id)).toEqual(["b"]);
    expect(searchChatSummaries(summaries, "blog").map((chat) => chat.id)).toEqual(["b"]);
    expect(searchChatSummaries(summaries, "")).toHaveLength(2);
    expect(searchChatSummaries(summaries, "nothing")).toEqual([]);
  });
});
