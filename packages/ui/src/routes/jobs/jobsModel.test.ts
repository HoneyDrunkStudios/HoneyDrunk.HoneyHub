import { describe, expect, it } from "vitest";
import type { JobSnapshot, ProcessInfo } from "@honeydrunk/honeyhub-types";
import { filterProcesses, formatMemoryKb, runningCount } from "./jobsModel";

describe("jobsModel", () => {
  it("formats memory across KB / MB / GB and handles missing", () => {
    expect(formatMemoryKb(undefined)).toBe("—");
    expect(formatMemoryKb(0)).toBe("—");
    expect(formatMemoryKb(512)).toBe("512 KB");
    expect(formatMemoryKb(2048)).toBe("2.0 MB");
    expect(formatMemoryKb(50 * 1024)).toBe("50 MB");
    expect(formatMemoryKb(3 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("counts running known jobs", () => {
    const snapshot: JobSnapshot = {
      known: [
        { label: "a", patterns: [], running: true, instances: 1, pids: [1], memoryKb: 0 },
        { label: "b", patterns: [], running: false, instances: 0, pids: [], memoryKb: 0 }
      ],
      scheduled: [],
      processes: [],
      truncated: false
    };
    expect(runningCount(snapshot)).toBe(1);
  });

  it("filters processes by case-insensitive name or command substring", () => {
    const processes: ProcessInfo[] = [
      { pid: 1, name: "node.exe", command: "node vite dev" },
      { pid: 2, name: "Claude.exe" },
      { pid: 3, name: "powershell.exe", command: "powershell -File grid-agent-runner/run.ps1" }
    ];
    expect(filterProcesses(processes, "")).toHaveLength(3);
    expect(filterProcesses(processes, "claude").map((p) => p.pid)).toEqual([2]);
    expect(filterProcesses(processes, "EXE")).toHaveLength(3);
    // Matches on the command line, not just the image name.
    expect(filterProcesses(processes, "grid-agent-runner").map((p) => p.pid)).toEqual([3]);
    expect(filterProcesses(processes, "vite").map((p) => p.pid)).toEqual([1]);
  });
});
