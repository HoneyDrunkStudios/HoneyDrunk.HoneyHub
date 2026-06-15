import type { WorkItem } from "@honeydrunk/honeyhub-types";

// Pure helpers for the Work hub: case-insensitive filtering across the fields you'd search by,
// and a clean split into ordered category buckets. Kept out of the component so they're
// unit-testable.

/** Filter by a case-insensitive substring over title + repository + labels + number (blank =
    all), so you can find an item by what it's about, not just its title. */
export function filterWorkItems(items: WorkItem[], query: string): WorkItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return items;
  }
  return items.filter((item) => {
    const haystack = [
      item.title,
      item.repository,
      item.number === undefined ? "" : `#${item.number}`,
      (item.labels ?? []).join(" ")
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface WorkGroup {
  category: string;
  items: WorkItem[];
}

// A stable, sensible display order for the known categories; anything else sorts after, alpha.
const CATEGORY_ORDER = ["Assigned", "Authored", "Review requested"];

/** Split items into ordered category buckets (preserving item order within each bucket). */
export function groupByCategory(items: WorkItem[]): WorkGroup[] {
  const buckets = new Map<string, WorkItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.category);
    if (bucket === undefined) {
      buckets.set(item.category, [item]);
    } else {
      bucket.push(item);
    }
  }
  return [...buckets.entries()]
    .map(([category, bucketItems]) => ({ category, items: bucketItems }))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category);
      const bi = CATEGORY_ORDER.indexOf(b.category);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      }
      return a.category.localeCompare(b.category);
    });
}

/** Total item count across sources (for the header tally). */
export function totalItems(items: WorkItem[]): number {
  return items.length;
}
