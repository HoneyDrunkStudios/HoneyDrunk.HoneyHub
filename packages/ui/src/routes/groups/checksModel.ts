import type { CheckOutcome } from "@honeydrunk/honeyhub-types";

// Group checks: the per-repo NAMED check the user picks, and the live state of running
// those checks across a change group. Pure helpers + a thin localStorage seam (mirroring
// jobPatterns), kept out of the view so they're unit-testable. The client never sends a
// command line — only a check id the bridge resolves against its own host-owned
// definitions (crates/bridge/src/checks.rs; this list mirrors its built-ins).

const STORAGE_KEY = "honeyhub.groupChecks.v2";
/** The free-text-command era key, migrated (mappable values only) then removed. */
const LEGACY_STORAGE_KEY = "honeyhub.groupChecks.v1";

/** The named check IDS the bridge's built-in set offers. Ids only — what an id
    resolves to is host knowledge (the operator's HONEYHUB_EXTRA_CHECKS may override
    a built-in), so the picker never claims a command line; the outcome echoes the
    command the host actually ran. Operator extras are not offered by this picker
    yet — surfacing the host's full check table over the wire is the planned
    follow-up that retires this mirror. */
export const KNOWN_CHECK_IDS: readonly string[] = [
  "npm-test",
  "npm-build",
  "cargo-test",
  "dotnet-test",
  "go-test",
  "pytest",
  "make-test"
];

/** The fallback check when a repo has no pick. A sensible default for the
    TypeScript-native repos the cockpit targets; the user can override per repo. */
export const DEFAULT_CHECK_ID = "npm-test";

/** The picked check id for a repo root, falling back to the default. (Picks come
    from the closed <select> and the validated loader, so only known ids exist.) */
export function checkIdFor(picks: Readonly<Record<string, string>>, root: string): string {
  return picks[root] ?? DEFAULT_CHECK_ID;
}

/** Set (or clear) a repo's picked check. The default id removes the override so the
    repo reverts to the default. Returns a new map. */
export function setCheckId(
  picks: Readonly<Record<string, string>>,
  root: string,
  checkId: string
): Record<string, string> {
  const next = { ...picks };
  if (checkId === DEFAULT_CHECK_ID) {
    delete next[root];
  } else {
    next[root] = checkId;
  }
  return next;
}

/** v1 (free-text command) values that map cleanly onto a named check, so a user's
    old per-repo declarations survive the picker migration instead of resetting. */
const V1_COMMAND_TO_ID: Readonly<Record<string, string>> = {
  "npm test": "npm-test",
  "npm run build": "npm-build",
  "cargo test": "cargo-test",
  "cargo test --workspace": "cargo-test",
  "dotnet test": "dotnet-test",
  "go test ./...": "go-test",
  pytest: "pytest",
  "make test": "make-test"
};

/** Parse one storage blob into a root → known-check-id map, mapping v1 command lines
    through `V1_COMMAND_TO_ID` and dropping everything unrecognized. */
function parsePicks(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [root, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      continue;
    }
    const id = V1_COMMAND_TO_ID[value.trim()] ?? value;
    if (KNOWN_CHECK_IDS.includes(id)) {
      out[root] = id;
    }
  }
  return out;
}

/** Read the saved per-repo check picks. Tolerant of absent/garbled storage (returns {}).
    Only known ids survive. A v1 blob (free-text commands) is migrated once: mappable
    commands become their named-check ids, the rest fall back to the default. */
export function loadCheckIds(): Record<string, string> {
  try {
    const storage = globalThis.localStorage;
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw !== null && raw !== undefined) {
      return parsePicks(raw);
    }
    const legacy = storage?.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null || legacy === undefined) {
      return {};
    }
    const migrated = parsePicks(legacy);
    storage?.setItem(STORAGE_KEY, JSON.stringify(migrated));
    storage?.removeItem(LEGACY_STORAGE_KEY);
    return migrated;
  } catch {
    return {};
  }
}

/** Persist the per-repo check picks. Best-effort: a read-only/throwing Storage is
    swallowed. */
export function saveCheckIds(picks: Readonly<Record<string, string>>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(picks));
  } catch {
    // Storage unavailable (private mode / test env) — keep the in-memory map only.
  }
}

// --- Live run state ---

export type CheckPhase = "running" | "passed" | "failed";

export interface CheckState {
  root: string;
  /** The display command (or the check id until the outcome echoes one). */
  command: string;
  phase: CheckPhase;
  /** Combined output once the check has finished (absent while running). */
  output?: string;
  exitCode?: number;
  truncated?: boolean;
}

/** All in-flight / finished checks, keyed by repo root (one check per repo at a time). */
export type ChecksState = Record<string, CheckState>;

/** Mark a repo's check as started (running), replacing any prior result for that repo. */
export function startCheck(
  state: ChecksState,
  init: { root: string; command: string }
): ChecksState {
  return {
    ...state,
    [init.root]: { root: init.root, command: init.command, phase: "running" }
  };
}

/** The host's per-root overlap refusal (bridge-host `spawn_check`); the one denial that
    is NOT the terminal answer to a running check — the in-flight run's real outcome is
    still coming. Kept in lockstep with the host string (both ends live in this repo). */
const OVERLAP_DENIAL = "a check is already running";

/** Fold a finished `check_result` outcome into the state: passed/failed with its output.
    An outcome for a repo we never started is still recorded (the host is the source of
    truth), so a result is never silently dropped. The one exception: results broadcast
    to every cockpit, so an OVERLAP denial (another surface, or two path spellings of one
    repo) must not clobber a live running pill — every other denial (unknown check id,
    allowlist refusal, panicked task) IS our request's final answer and lands as failed. */
export function applyCheckOutcome(state: ChecksState, outcome: CheckOutcome): ChecksState {
  if (
    outcome.disposition === "denied" &&
    state[outcome.root]?.phase === "running" &&
    outcome.output.includes(OVERLAP_DENIAL)
  ) {
    return state;
  }
  return {
    ...state,
    [outcome.root]: {
      root: outcome.root,
      command: outcome.command,
      phase: outcome.ok ? "passed" : "failed",
      output: outcome.output,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome.truncated ? { truncated: true } : {})
    }
  };
}

export interface ChecksSummary {
  running: number;
  passed: number;
  failed: number;
  total: number;
}

/** Tally a set of check states (e.g. the members of one group) for an at-a-glance badge. */
export function summarizeChecks(states: readonly CheckState[]): ChecksSummary {
  let running = 0;
  let passed = 0;
  let failed = 0;
  for (const state of states) {
    if (state.phase === "running") {
      running += 1;
    } else if (state.phase === "passed") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { running, passed, failed, total: states.length };
}
