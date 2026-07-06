import type { AgentBackend, DispatchMessage, UsageSummary } from "@honeydrunk/honeyhub-types";

// Local chat history (packet 09 §3c). Each finished/updated chat is saved so you can
// reopen past sessions. This is the per-device client-side store; a bridge-backed store
// (durable + multi-device, via the existing LocalStore) is the planned upgrade — this
// keeps the same ChatRecord shape so the swap is transparent.

const STORAGE_KEY = "honeyhub.chats.v1";
const MAX_CHATS = 100;

export interface ChatRecord {
  id: string;
  task: string;
  /** A user-given name (rename); the first task text remains the fallback display. */
  title?: string;
  /** Pinned chats sort above the rest and survive the history cap. */
  pinned?: boolean;
  backend?: AgentBackend;
  model?: string;
  state: string;
  messages: DispatchMessage[];
  totalUsd: number;
  totalTokens: number;
  /** Per-(backend, fidelity) usage rollup for the thread, when the bridge store has
      one (synced sessions reopened from the host); local records omit it. */
  usage?: UsageSummary;
  createdAt: string;
  updatedAt: string;
}

/** A lightweight summary for the history list (no transcript). Carries a `messageCount`
    so the list can show a per-thread status light ("done with answers" vs "active")
    without hauling the whole transcript around. */
export type ChatSummary = Omit<ChatRecord, "messages"> & {
  /** How many transcript messages the thread has (0 for an empty draft placeholder). */
  messageCount: number;
};

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

/** Pinned first (each bucket newest-first) — the display AND cap-eviction order, so
    pinning both floats a chat to the top and protects it from the history cap. Typed on
    the minimal fields it reads so it sorts both full records and summaries. */
function byPinThenRecency(
  a: Pick<ChatRecord, "pinned" | "updatedAt">,
  b: Pick<ChatRecord, "pinned" | "updatedAt">
): number {
  const pinA = a.pinned === true ? 1 : 0;
  const pinB = b.pinned === true ? 1 : 0;
  if (pinA !== pinB) {
    return pinB - pinA;
  }
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/** Summaries for the history list: pinned first, then newest-first. Drops the transcript
    but keeps its length as `messageCount` for the status-light logic. */
export function loadChatSummaries(): ChatSummary[] {
  return loadChats()
    .map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }))
    .sort(byPinThenRecency);
}

/** The display name for a chat: the user's rename when set, else its first task text. */
export function chatTitle(chat: Pick<ChatRecord, "task" | "title">): string {
  const title = chat.title?.trim() ?? "";
  return title === "" ? chat.task : title;
}

/** Case-insensitive title/task filter for the history search box. Empty query = all. */
export function searchChatSummaries(summaries: ChatSummary[], query: string): ChatSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return summaries;
  }
  return summaries.filter(
    (chat) =>
      chatTitle(chat).toLowerCase().includes(needle) || chat.task.toLowerCase().includes(needle)
  );
}

export function getChat(id: string): ChatRecord | undefined {
  return loadChats().find((chat) => chat.id === id);
}

/** Persist a full chat list: sorted, capped (pinned sort first, so the cap evicts old
    unpinned chats), best-effort. */
function persistChats(chats: ChatRecord[]): void {
  try {
    chats.sort(byPinThenRecency);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
  } catch {
    // Best-effort: history is a convenience, not load-bearing.
  }
}

/** Insert or update a chat by id, preserving a prior rename/pin when the caller's
    record does not carry them (the live-run saver rebuilds records from run state). */
export function saveChat(record: ChatRecord): void {
  const chats = loadChats();
  const prior = chats.find((chat) => chat.id === record.id);
  const merged: ChatRecord = {
    ...record,
    ...(record.title === undefined && prior?.title !== undefined ? { title: prior.title } : {}),
    ...(record.pinned === undefined && prior?.pinned !== undefined
      ? { pinned: prior.pinned }
      : {})
  };
  persistChats([...chats.filter((chat) => chat.id !== record.id), merged]);
}

/** Rename a chat (empty title clears the rename, falling back to the task text). */
export function renameChat(id: string, title: string): void {
  const trimmed = title.trim();
  persistChats(
    loadChats().map((chat) => {
      if (chat.id !== id) {
        return chat;
      }
      const { title: _oldTitle, ...rest } = chat;
      return trimmed === "" ? rest : { ...rest, title: trimmed };
    })
  );
}

/** Delete a chat from local history. */
export function deleteChat(id: string): void {
  persistChats(loadChats().filter((chat) => chat.id !== id));
}

/** Pin or unpin a chat. Pinned chats sort to the top and survive the cap. */
export function setChatPinned(id: string, pinned: boolean): void {
  persistChats(
    loadChats().map((chat) => {
      if (chat.id !== id) {
        return chat;
      }
      const { pinned: _oldPinned, ...rest } = chat;
      return pinned ? { ...rest, pinned: true } : rest;
    })
  );
}
