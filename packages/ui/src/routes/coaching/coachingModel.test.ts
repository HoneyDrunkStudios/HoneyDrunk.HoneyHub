import { describe, expect, it } from "vitest";
import type { PolicyHint, PolicyHintSeverity } from "@honeydrunk/honeyhub-types";
import { hintTitle, severityLabel, sortHints } from "./coachingModel";

function hint(
  id: string,
  code: string,
  severity: PolicyHintSeverity,
  createdAt = "2026-06-08T12:00:00Z"
): PolicyHint {
  return {
    id,
    sessionId: "s1",
    code,
    severity,
    message: `${code} message`,
    createdAt
  };
}

describe("sortHints", () => {
  it("orders warnings before info, then most-recent first", () => {
    const ordered = sortHints([
      hint("a", "estimate_only_spend", "info", "2026-06-08T12:00:00Z"),
      hint("b", "stale_session", "warning", "2026-06-08T11:00:00Z"),
      hint("c", "high_cost_session", "warning", "2026-06-08T12:30:00Z")
    ]);
    // Both warnings first (newest warning leads), then the info hint.
    expect(ordered.map((h) => h.id)).toEqual(["c", "b", "a"]);
  });

  it("is stable by id for identical severity and timestamp", () => {
    const ordered = sortHints([
      hint("z", "high_cost_session", "warning"),
      hint("a", "stale_session", "warning")
    ]);
    expect(ordered.map((h) => h.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [hint("a", "stale_session", "info"), hint("b", "stale_session", "warning")];
    const before = input.map((h) => h.id);
    sortHints(input);
    expect(input.map((h) => h.id)).toEqual(before);
  });
});

describe("labels", () => {
  it("labels severities for humans", () => {
    expect(severityLabel("warning")).toBe("Warning");
    expect(severityLabel("info")).toBe("Info");
    expect(severityLabel("block")).toBe("Action");
  });

  it("titles known rule codes and humanizes unknown ones", () => {
    expect(hintTitle("stale_session")).toBe("Long session");
    expect(hintTitle("high_cost_session")).toBe("High spend");
    expect(hintTitle("estimate_only_spend")).toBe("Estimated usage");
    expect(hintTitle("some_new_rule")).toBe("some new rule");
  });
});
