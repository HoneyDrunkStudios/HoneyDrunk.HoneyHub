// Small path helpers shared across surfaces (Browse, the workspace picker). Kept regex-free
// and linear on purpose — the previous `path.replace(/[\\/]+$/, "")` form tripped a Sonar
// super-linear-backtracking (ReDoS) hotspot, and the logic is clearer as an explicit scan.

/** The last path segment, tolerant of mixed `/` and `\` separators and trailing separators.
    `"a/b/c/"` → `"c"`, `"a\\b"` → `"b"`, `"c"` → `"c"`, `"/"` → `""`. */
export function basename(path: string): string {
  const isSep = (ch: string): boolean => ch === "/" || ch === "\\";
  // Trim trailing separators.
  let end = path.length;
  while (end > 0 && isSep(path[end - 1] as string)) {
    end -= 1;
  }
  // Walk back to the start of the final segment.
  let start = end;
  while (start > 0 && !isSep(path[start - 1] as string)) {
    start -= 1;
  }
  return path.slice(start, end);
}

/** True when `path` is at or below `root`, tolerant of mixed `/` and `\` separators (the OS
    watcher emits native paths, which may differ from how a root is stored). Boundary-aware:
    `"C:/repos/Hub"` does NOT contain `"C:/repos/HubLegacy/x"`. Regex-free, linear. */
export function isWithin(path: string, root: string): boolean {
  if (root.length === 0) {
    return false;
  }
  const norm = (value: string): string => value.split("\\").join("/");
  let base = norm(root);
  while (base.length > 1 && base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const target = norm(path);
  return target === base || target.startsWith(`${base}/`);
}
