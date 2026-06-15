import { describe, expect, it } from "vitest";
import { attentionTone, formatRelative } from "./hubModel";

describe("hubModel", () => {
  it("formats relative time coarsely", () => {
    const now = 1_000_000_000;
    expect(formatRelative(now, now)).toBe("just now");
    expect(formatRelative(now, now - 5_000)).toBe("just now");
    expect(formatRelative(now, now - 30_000)).toBe("30s ago");
    expect(formatRelative(now, now - 120_000)).toBe("2m ago");
    expect(formatRelative(now, now - 2 * 3_600_000)).toBe("2h ago");
    expect(formatRelative(now, now - 3 * 86_400_000)).toBe("3d ago");
    // Never negative, even if the clock skews.
    expect(formatRelative(now, now + 5_000)).toBe("just now");
  });

  it("treats a non-zero attention count as a warning", () => {
    expect(attentionTone(0)).toBe("ok");
    expect(attentionTone(3)).toBe("warn");
  });
});
