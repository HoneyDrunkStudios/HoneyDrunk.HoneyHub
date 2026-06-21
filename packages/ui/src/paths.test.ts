import { describe, expect, it } from "vitest";
import { basename, isWithin } from "./paths";

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

describe("isWithin", () => {
  it("matches a path at or below a root, tolerant of separators", () => {
    expect(isWithin("C:\\repos\\Hub\\src\\a.rs", "C:/repos/Hub")).toBe(true);
    expect(isWithin("C:/repos/Hub", "C:/repos/Hub")).toBe(true);
    expect(isWithin("C:/repos/Hub/", "C:/repos/Hub")).toBe(true);
    expect(isWithin("/home/me/proj/x", "/home/me/proj/")).toBe(true);
  });

  it("respects path-segment boundaries (no prefix bleed)", () => {
    expect(isWithin("C:/repos/HubLegacy/x.rs", "C:/repos/Hub")).toBe(false);
    expect(isWithin("C:/other/x", "C:/repos/Hub")).toBe(false);
  });

  it("never matches an empty root", () => {
    expect(isWithin("C:/anything", "")).toBe(false);
  });
});
