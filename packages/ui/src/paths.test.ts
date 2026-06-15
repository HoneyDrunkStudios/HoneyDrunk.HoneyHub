import { describe, expect, it } from "vitest";
import { basename } from "./paths";

describe("basename", () => {
  it("returns the final segment across separators and trailing slashes", () => {
    expect(basename("a/b/c")).toBe("c");
    expect(basename("a/b/c/")).toBe("c");
    expect(basename("a\\b\\c")).toBe("c");
    expect(basename("a\\b\\c\\")).toBe("c");
    expect(basename("C:\\repos\\HoneyDrunk.HoneyHub")).toBe("HoneyDrunk.HoneyHub");
    expect(basename("/usr/local/")).toBe("local");
    expect(basename("solo")).toBe("solo");
    expect(basename("/")).toBe("");
    expect(basename("")).toBe("");
  });
});
