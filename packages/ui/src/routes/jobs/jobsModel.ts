import type { JobSnapshot, ProcessInfo } from "@honeydrunk/honeyhub-types";

// Small pure helpers for the Local Jobs surface (control-hub roadmap #7): memory
// formatting, the up/down tally, and process-list filtering — kept out of the component
// so they are unit-testable.

/** Format a KiB figure as a human-readable size (KB / MB / GB). */
export function formatMemoryKb(memoryKb: number | undefined): string {
  if (memoryKb === undefined || memoryKb <= 0) {
    return "-";
  }
  if (memoryKb < 1024) {
    return `${memoryKb} KB`;
  }
  const mb = memoryKb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** How many of the curated known jobs are currently running. */
export function runningCount(snapshot: JobSnapshot): number {
  return snapshot.known.filter((job) => job.running).length;
}

/** Filter the process list by a case-insensitive substring over name + command (blank =
    all), so you can find a process by what it's actually running, not just its image name. */
export function filterProcesses(processes: ProcessInfo[], query: string): ProcessInfo[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return processes;
  }
  return processes.filter((process) => {
    const haystack = `${process.name} ${process.command ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}
