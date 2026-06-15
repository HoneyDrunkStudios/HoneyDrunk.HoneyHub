import type { AgentBackend, DispatchMessage } from "@honeydrunk/honeyhub-types";

// Local chat history (packet 09 §3c). Each finished/updated chat is saved so you can
// reopen past sessions. This is the per-device client-side store; a bridge-backed store
// (durable + multi-device, via the existing LocalStore) is the planned upgrade — this
// keeps the same ChatRecord shape so the swap is transparent.

const STORAGE_KEY = "honeyhub.chats.v1";
const MAX_CHATS = 100;

export interface ChatRecord {
  id: string;
  task: string;
  backend?: AgentBackend;
  model?: string;
  state: string;
  messages: DispatchMessage[];
  totalUsd: number;
  totalTokens: number;
  createdAt: string;
  updatedAt: string;
}

/** A lightweight summary for the history list (no transcript). */
export type ChatSummary = Omit<ChatRecord, "messages">;

export function loadChats(): ChatRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is ChatRecord =>
        typeof item === "object" && item !== null && typeof (item as ChatRecord).id === "string"
    );
  } catch {
    return [];
  }
}

/** Summaries newest-first for the history list. */
export function loadChatSummaries(): ChatSummary[] {
  return loadChats()
    .map(({ messages: _messages, ...summary }) => summary)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getChat(id: string): ChatRecord | undefined {
  return loadChats().find((chat) => chat.id === id);
}

/** Insert or update a chat by id, capped to the most recent MAX_CHATS. Never throws. */
export function saveChat(record: ChatRecord): void {
  try {
    const chats = loadChats().filter((chat) => chat.id !== record.id);
    chats.push(record);
    chats.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const trimmed = chats.slice(0, MAX_CHATS);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Best-effort: history is a convenience, not load-bearing.
  }
}
