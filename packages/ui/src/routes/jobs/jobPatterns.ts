import type { JobProbe } from "@honeydrunk/honeyhub-types";

// Configurable job patterns (control-hub roadmap #7): the user's own job probes, persisted
// locally and merged onto HoneyHub's built-in set by the host on every `list_jobs`. Pure
// helpers + a thin localStorage seam, kept out of the component so they're unit-testable.

const STORAGE_KEY = "honeyhub.jobPatterns.v1";

/** Split a comma- (or newline-) separated pattern entry into trimmed, de-duplicated,
    lowercased substrings, dropping blanks. Matching is case-insensitive, so we normalize
    here too — what you see saved is what the host matches. */
export function parsePatterns(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.length > 0 && !seen.has(pattern)) {
      seen.add(pattern);
      out.push(pattern);
    }
  }
  return out;
}

/** Add (or replace, by case-insensitive label) a user probe. Returns the new list, or the
    unchanged list when the label or patterns are empty — a blank probe must never be saved
    (an empty pattern would match every process). */
export function addProbe(existing: JobProbe[], label: string, patternsInput: string): JobProbe[] {
  const trimmedLabel = label.trim();
  const patterns = parsePatterns(patternsInput);
  if (trimmedLabel.length === 0 || patterns.length === 0) {
    return existing;
  }
  const lower = trimmedLabel.toLowerCase();
  const filtered = existing.filter((probe) => probe.label.toLowerCase() !== lower);
  return [...filtered, { label: trimmedLabel, patterns }];
}

/** Remove a user probe by exact label. */
export function removeProbe(existing: JobProbe[], label: string): JobProbe[] {
  return existing.filter((probe) => probe.label !== label);
}

/** A probe is shaped right when it has a non-empty label and at least one pattern. */
function isValidProbe(value: unknown): value is JobProbe {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const probe = value as Partial<JobProbe>;
  return (
    typeof probe.label === "string" &&
    probe.label.trim().length > 0 &&
    Array.isArray(probe.patterns) &&
    probe.patterns.length > 0 &&
    probe.patterns.every((pattern) => typeof pattern === "string")
  );
}

/** Read the saved user probes. Tolerant of absent/garbled storage (returns []). */
export function loadJobPatterns(): JobProbe[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidProbe);
  } catch {
    return [];
  }
}

/** Persist the user probes. Best-effort: a read-only/throwing Storage is swallowed so the
    in-memory list still works for the session. */
export function saveJobPatterns(probes: JobProbe[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(probes));
  } catch {
    // Storage unavailable (private mode / test env) — keep the in-memory list only.
  }
}
