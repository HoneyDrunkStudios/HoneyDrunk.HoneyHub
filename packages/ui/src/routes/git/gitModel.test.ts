import { describe, expect, it } from "vitest";
import type { GitFileStatus, GitOverview, GitStatus } from "@honeydrunk/honeyhub-types";
import {
  classifyDiffLine,
  diffStat,
  groupFiles,
  replaceRepoStatus,
  toDiffLines
} from "./gitModel";

function status(root: string, clean: boolean): GitStatus {
  return { root, ahead: 0, behind: 0, files: [], clean };
}

describe("multi-repo helpers", () => {
  it("replaces a repo's status within an overview, appending if absent", () => {
    const overview: GitOverview = {
      root: "/folder",
      repos: [status("/folder/a", true), status("/folder/b", true)]
    };
    const updated = replaceRepoStatus(overview, status("/folder/b", false));
    expect(updated.repos.find((r) => r.root === "/folder/b")?.clean).toBe(false);
    expect(updated.repos).toHaveLength(2);

    const appended = replaceRepoStatus(overview, status("/folder/c", false));
    expect(appended.repos).toHaveLength(3);
  });

  it("groups files into staged vs unstaged (untracked counts as unstaged)", () => {
    const files: GitFileStatus[] = [
      { path: "a", status: "M ", staged: true, untracked: false },
      { path: "b", status: " M", staged: false, untracked: false },
      { path: "c", status: "??", staged: false, untracked: true }
    ];
    const { staged, unstaged } = groupFiles(files);
    expect(staged.map((f) => f.path)).toEqual(["a"]);
    expect(unstaged.map((f) => f.path)).toEqual(["b", "c"]);
  });
});

describe("gitModel", () => {
  it("classifies diff lines, with file headers as meta (not add/del)", () => {
    expect(classifyDiffLine("+++ b/file")).toBe("meta");
    expect(classifyDiffLine("--- a/file")).toBe("meta");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("index abc..def 100644")).toBe("meta");
    expect(classifyDiffLine("@@ -1,3 +1,3 @@")).toBe("hunk");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" context")).toBe("context");
  });

  it("counts added/removed content lines excluding file headers", () => {
    const patch =
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+extra\n context\n";
    const stat = diffStat(patch);
    expect(stat.added).toBe(2);
    expect(stat.removed).toBe(1);
  });

  it("splits a patch into classified lines and drops a trailing blank", () => {
    const lines = toDiffLines("@@ -1 +1 @@\n+x\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.kind).toBe("hunk");
    expect(lines[1]!).toEqual({ kind: "add", text: "+x" });
  });
});
