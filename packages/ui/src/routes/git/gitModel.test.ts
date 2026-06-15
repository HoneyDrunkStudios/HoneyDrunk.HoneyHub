import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffStat, toDiffLines } from "./gitModel";

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
