// The chat dock's dragged width: clamped like an editor panel and persisted so the
// cockpit keeps your layout across sessions.

const STORAGE_KEY = "honeyhub.chatDockWidth.v1";

export const CHAT_DOCK_MIN_WIDTH = 320;
export const CHAT_DOCK_MAX_WIDTH = 720;
export const CHAT_DOCK_DEFAULT_WIDTH = 380;

/** Clamp a dragged width into the dock's allowed range. */
export function clampChatDockWidth(width: number): number {
  return Math.min(CHAT_DOCK_MAX_WIDTH, Math.max(CHAT_DOCK_MIN_WIDTH, Math.round(width)));
}

/** Load the persisted width, tolerating absent/garbled storage (returns the default). */
export function loadChatDockWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampChatDockWidth(parsed) : CHAT_DOCK_DEFAULT_WIDTH;
  } catch {
    return CHAT_DOCK_DEFAULT_WIDTH;
  }
}

/** Persist the width. Best-effort: a read-only/throwing Storage is swallowed. */
export function saveChatDockWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(clampChatDockWidth(width)));
  } catch {
    // Storage unavailable — the width just resets next session.
  }
}
