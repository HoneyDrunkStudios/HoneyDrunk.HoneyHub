import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownJob } from "@honeydrunk/honeyhub-types";
import { loadJobHistory, recordJobHistory } from "./jobHistory";

function job(label: string, running: boolean, instances: number): KnownJob {
  return { label, patterns: [label], running, instances, pids: [], memoryKb: 1024 };
}

// The runtime's localStorage varies by Node version (absent without --localstorage-file on
// newer Nodes), so stub a fresh in-memory Storage per test, like chatHistory.test.ts does.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("job history", () => {
  it("records state transitions only, not every refresh", () => {
    let history = recordJobHistory({}, [job("worker", true, 1)], "2026-07-03T10:00:00Z");
    // Same state again: no new entry.
    history = recordJobHistory(history, [job("worker", true, 1)], "2026-07-03T10:05:00Z");
    expect(history["worker"]).toHaveLength(1);
    // A stop and a scale-up both record.
    history = recordJobHistory(history, [job("worker", false, 0)], "2026-07-03T11:00:00Z");
    history = recordJobHistory(history, [job("worker", true, 2)], "2026-07-03T12:00:00Z");
    expect(history["worker"]?.map((entry) => entry.at)).toEqual([
      "2026-07-03T10:00:00Z",
      "2026-07-03T11:00:00Z",
      "2026-07-03T12:00:00Z"
    ]);
  });

  it("persists and reloads, tolerating garbage", () => {
    recordJobHistory({}, [job("worker", true, 1)], "2026-07-03T10:00:00Z");
    expect(loadJobHistory()["worker"]).toHaveLength(1);

    globalThis.localStorage?.setItem("honeyhub.jobHistory.v1", "not json");
    expect(loadJobHistory()).toEqual({});
    globalThis.localStorage?.setItem(
      "honeyhub.jobHistory.v1",
      JSON.stringify({ worker: [{ at: 42 }], ok: [{ at: "t", running: true, instances: 1, memoryKb: 2 }] })
    );
    expect(loadJobHistory()).toEqual({ ok: [{ at: "t", running: true, instances: 1, memoryKb: 2 }] });
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => recordJobHistory({}, [job("worker", true, 1)], "t")).not.toThrow();
    expect(loadJobHistory()).toEqual({});
  });
});
