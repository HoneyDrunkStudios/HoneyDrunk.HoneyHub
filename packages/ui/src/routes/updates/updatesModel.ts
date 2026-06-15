import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";

// New-model awareness (control-hub roadmap #8). The bridge re-reads each CLI's own model
// cache (via the backend catalog); this module diffs that against the set of model ids the
// user has previously seen, so genuinely *new* models get badged. Pure + storage-free.
//
// First-sight rule: a backend with NO prior record is treated as a baseline (no badges) —
// the snapshot is saved silently so only models that appear *afterwards* are flagged. This
// avoids dumping every model as "new" on first run.

export type SeenModels = Partial<Record<AgentBackend, string[]>>;

export type NewModels = Partial<Record<AgentBackend, string[]>>;

/** Model ids present now but not in the seen set, per backend. A backend with no prior
    record contributes nothing (it is a baseline, recorded by `mergeSeen`). */
export function diffNewModels(catalog: BackendCapability[], seen: SeenModels): NewModels {
  const result: NewModels = {};
  for (const entry of catalog) {
    const seenIds = seen[entry.backend];
    if (seenIds === undefined) {
      continue; // first sight of this backend — baseline, not "new"
    }
    const fresh = entry.models.map((model) => model.id).filter((id) => !seenIds.includes(id));
    if (fresh.length > 0) {
      result[entry.backend] = fresh;
    }
  }
  return result;
}

/** Union the current catalog ids into the seen set (per backend), so a model stays seen
    once acknowledged and a newly-sighted backend is baselined. */
export function mergeSeen(catalog: BackendCapability[], seen: SeenModels): SeenModels {
  const next: SeenModels = { ...seen };
  for (const entry of catalog) {
    const existing = next[entry.backend] ?? [];
    const union = new Set(existing);
    for (const model of entry.models) {
      union.add(model.id);
    }
    next[entry.backend] = [...union];
  }
  return next;
}

/** True when any backend has a new model. */
export function hasNewModels(diff: NewModels): boolean {
  return Object.values(diff).some((ids) => ids !== undefined && ids.length > 0);
}

/** Total count of new models across backends. */
export function newModelCount(diff: NewModels): number {
  return Object.values(diff).reduce((sum, ids) => sum + (ids?.length ?? 0), 0);
}
