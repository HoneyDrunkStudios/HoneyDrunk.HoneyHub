import type { SeenModels } from "./updatesModel";

// Persists the set of model ids the user has already seen, so new-model detection has a
// baseline across launches. localStorage, best-effort, never throws — same pattern as the
// plan/chat stores. A backend absent from the map = never seen (a baseline, not "new").

const STORAGE_KEY = "honeyhub.modelsSeen.v1";

export function loadSeenModels(): SeenModels {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveSeenModels(seen: SeenModels): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Best-effort: a missing baseline just means the next detection re-baselines.
  }
}
