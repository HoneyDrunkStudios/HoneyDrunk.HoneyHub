import type { GitFileStatus, GitOverview, GitStatus } from "@honeydrunk/honeyhub-types";

// Pure helpers for rendering a unified diff (parity polish #9). Classifying each line so
// the viewer can colour it, and a small +/- stat — kept out of the component for testing.

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Classify one unified-diff line. File-header markers (`+++`/`---`, `diff`, `index`,
    `new file`, …) are `meta`; `@@` is a `hunk` header; `+`/`-` are add/del; else context. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "meta";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

/** Split a patch into classified lines (a trailing empty line is dropped). */
export function toDiffLines(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((text) => ({ kind: classifyDiffLine(text), text }));
}

/** Count added/removed content lines (excludes the `+++`/`---` file headers). */
export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    const kind = classifyDiffLine(line);
    if (kind === "add") {
      added += 1;
    } else if (kind === "del") {
      removed += 1;
    }
  }
  return { added, removed };
}

// --- Multi-repo helpers (the Git dashboard) ---

/** Replace a single repo's status within an overview (a write re-emits one repo's status),
    appending it if the repo is not already listed. Pure, so the merge is testable. */
export function replaceRepoStatus(overview: GitOverview, status: GitStatus): GitOverview {
  const exists = overview.repos.some((repo) => repo.root === status.root);
  return {
    ...overview,
    repos: exists
      ? overview.repos.map((repo) => (repo.root === status.root ? status : repo))
      : [...overview.repos, status]
  };
}

export interface GroupedFiles {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
}

/** Split a repo's changed files into staged vs unstaged (untracked counts as unstaged). */
export function groupFiles(files: GitFileStatus[]): GroupedFiles {
  const staged: GitFileStatus[] = [];
  const unstaged: GitFileStatus[] = [];
  for (const file of files) {
    (file.staged ? staged : unstaged).push(file);
  }
  return { staged, unstaged };
}
