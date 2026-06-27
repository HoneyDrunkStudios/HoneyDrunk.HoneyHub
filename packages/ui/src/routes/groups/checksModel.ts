import type { CheckOutcome } from "@honeydrunk/honeyhub-types";

// Group checks: the per-repo "build/test" command the user declares, and the live state of
// running those commands across a change group. Pure helpers + a thin localStorage seam
// (mirroring jobPatterns), kept out of the view so they're unit-testable. The bridge runs
// the command shell-free; here we only choose what to run and fold the results.

const STORAGE_KEY = "honeyhub.groupChecks.v1";

/** The fallback command when a repo has no declared check. A sensible default for the
    TypeScript-native repos the cockpit targets; the user can override per repo. */
export const DEFAULT_CHECK_COMMAND = "npm test";

/** The declared check command for a repo root, falling back to the default. A blank stored
    entry also falls back, so an emptied field never runs nothing. */
export function checkCommandFor(commands: Readonly<Record<string, string>>, root: string): string {
  const declared = commands[root];
  return declared !== undefined && declared.trim().length > 0 ? declared : DEFAULT_CHECK_COMMAND;
}

/** Set (or clear) a repo's declared command. An empty/blank value removes the override so
    the repo reverts to the default. Returns a new map. */
export function setCheckCommand(
  commands: Readonly<Record<string, string>>,
  root: string,
  command: string
): Record<string, string> {
  const next = { ...commands };
  if (command.trim().length === 0) {
    delete next[root];
  } else {
    next[root] = command;
  }
  return next;
}

/** Read the saved per-repo commands. Tolerant of absent/garbled storage (returns {}). */
export function loadCheckCommands(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [root, command] of Object.entries(parsed)) {
      if (typeof command === "string") {
        out[root] = command;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the per-repo commands. Best-effort: a read-only/throwing Storage is swallowed. */
export function saveCheckCommands(commands: Readonly<Record<string, string>>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(commands));
  } catch {
    // Storage unavailable (private mode / test env) — keep the in-memory map only.
  }
}

// --- Live run state ---

export type CheckPhase = "running" | "passed" | "failed";

export interface CheckState {
  root: string;
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

/** Fold a finished `check_result` outcome into the state: passed/failed with its output.
    An outcome for a repo we never started is still recorded (the host is the source of
    truth), so a result is never silently dropped. */
export function applyCheckOutcome(state: ChecksState, outcome: CheckOutcome): ChecksState {
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
