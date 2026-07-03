import type { KnownJob } from "@honeydrunk/honeyhub-types";

// Local per-job history for the user's OWN jobs: each snapshot refresh records a state
// TRANSITION (running/instance-count changes, not every poll) per job label, so a job
// row can answer "when did this last start/stop?" without any host-side storage.
// Local-only and capped, like the other cockpit stores.

const STORAGE_KEY = "honeyhub.jobHistory.v1";
/** Cap per job, so a flapping process cannot grow the store unbounded. */
const MAX_ENTRIES = 50;

export interface JobHistoryEntry {
  /** When the transition was observed (ISO 8601). */
  at: string;
  running: boolean;
  instances: number;
  /** Summed resident memory (KiB) at observation time. */
  memoryKb: number;
}

export type JobHistory = Record<string, JobHistoryEntry[]>;

/** Read the saved history. Tolerant of absent/garbled storage (returns {}). */
export function loadJobHistory(): JobHistory {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: JobHistory = {};
    for (const [label, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      const valid = entries.filter(
        (entry): entry is JobHistoryEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as JobHistoryEntry).at === "string" &&
          typeof (entry as JobHistoryEntry).running === "boolean" &&
          typeof (entry as JobHistoryEntry).instances === "number" &&
          typeof (entry as JobHistoryEntry).memoryKb === "number"
      );
      if (valid.length > 0) {
        out[label] = valid.slice(-MAX_ENTRIES);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Fold a snapshot's user jobs into the history: append an entry per job whose
    running/instances state CHANGED since the last one (memory alone never appends —
    it fluctuates every poll). Pure: returns the SAME reference when nothing changed
    (so a state updater can skip a re-render) and never touches storage — callers
    persist via `saveJobHistory` in an effect. */
export function recordJobHistory(
  history: JobHistory,
  jobs: readonly KnownJob[],
  at: string
): JobHistory {
  let changed = false;
  const next: JobHistory = { ...history };
  for (const job of jobs) {
    const entries = next[job.label] ?? [];
    const last = entries[entries.length - 1];
    if (last !== undefined && last.running === job.running && last.instances === job.instances) {
      continue;
    }
    next[job.label] = [
      ...entries.slice(-(MAX_ENTRIES - 1)),
      { at, running: job.running, instances: job.instances, memoryKb: job.memoryKb }
    ];
    changed = true;
  }
  return changed ? next : history;
}

/** Persist the history. Best-effort: a read-only/throwing Storage is swallowed. */
export function saveJobHistory(history: JobHistory): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage unavailable — keep the in-memory history only.
  }
}
