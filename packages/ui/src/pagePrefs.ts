// Page visibility preferences (opt-out): which nav pages the operator wants in the daily nav.
// The cockpit is becoming an agent-first IDE, so the sidebar should be trimmable to the surfaces
// you actually use. Every toggleable page is visible by DEFAULT, except two that default OFF
// (Runs and Goals) — the operator asked to drop those from the daily nav but keep them re-enablable
// here. Core pages (Hub, Chat, Settings, Updates, Alerts) are always on and never listed here.
// Pure helpers, kept out of components so they're unit-testable. Mirrors the connectors.ts idiom.

/** view-id → visible. Absent id = the default for that page (see DEFAULT_HIDDEN_PAGES). */
export type PagePrefs = Record<string, boolean>;

/** The pages the user may toggle on/off. Order mirrors the primary nav. Excludes core pages
    (hub, run, settings, updates, notifications), which are always rendered. */
export const TOGGLEABLE_PAGES: { view: string; label: string }[] = [
  { view: "runs", label: "Runs" },
  { view: "groups", label: "Groups" },
  { view: "goals", label: "Goals" },
  { view: "plan", label: "Plan" },
  { view: "work", label: "Work" },
  { view: "jobs", label: "Jobs" },
  { view: "observe", label: "Observe" },
  { view: "repositories", label: "Repositories" },
  { view: "spend", label: "Spend" },
  { view: "coaching", label: "Coaching" },
  { view: "agents", label: "Agents" }
];

/** Pages hidden by default until the operator explicitly re-enables them. */
export const DEFAULT_HIDDEN_PAGES: readonly string[] = ["runs", "goals"];

const STORAGE_KEY = "honeyhub.pagePrefs.v1";

/** A page is visible unless explicitly set false — except default-hidden pages, which are hidden
    unless explicitly set true. An explicit stored boolean always wins over the default. */
export function isPageVisible(prefs: PagePrefs, view: string): boolean {
  const explicit = prefs[view];
  if (explicit !== undefined) {
    return explicit;
  }
  return !DEFAULT_HIDDEN_PAGES.includes(view);
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
