// Page visibility preferences (opt-out): which nav pages the operator wants in the daily nav.
// The cockpit is becoming an agent-first IDE, so the honeycomb should be trimmable to the surfaces
// you actually use. Every toggleable page is visible by DEFAULT (there are no default-hidden pages
// now that Runs and Goals have been removed entirely). Core pages (Hub, Chat, Settings, Updates,
// Alerts) are always on and never listed here. Pure helpers, kept out of components so they're
// unit-testable. Mirrors the connectors.ts idiom.

/** view-id → visible. An absent id means the page uses its default, which is visible for
    every toggleable page (there are no default-hidden pages). */
export type PagePrefs = Record<string, boolean>;

/** The pages the user may toggle on/off. Order mirrors the primary nav. Excludes core pages
    (hub, run, settings, updates, notifications), which are always rendered. */
export const TOGGLEABLE_PAGES: { view: string; label: string }[] = [
  { view: "groups", label: "Groups" },
  { view: "plan", label: "Plan" },
  { view: "work", label: "Work" },
  { view: "jobs", label: "Jobs" },
  { view: "observe", label: "Observe" },
  { view: "repositories", label: "Repositories" },
  { view: "terminal", label: "Terminal" },
  { view: "spend", label: "Spend" },
  { view: "coaching", label: "Coaching" },
  { view: "agents", label: "Agents" }
];

const STORAGE_KEY = "honeyhub.pagePrefs.v1";

/** A page is visible unless explicitly set false: every toggleable page defaults visible (there
    are no default-hidden pages), and an explicit stored boolean always wins over that default. */
export function isPageVisible(prefs: PagePrefs, view: string): boolean {
  return prefs[view] ?? true;
}

export function loadPagePrefs(): PagePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const out: PagePrefs = {};
    for (const [view, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") {
        out[view] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function savePagePrefs(prefs: PagePrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — keep the in-memory prefs for this session only.
  }
}
