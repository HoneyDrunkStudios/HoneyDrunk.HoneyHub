import { describe, expect, it } from "vitest";
import type { WorkItem } from "@honeydrunk/honeyhub-types";
import { filterWorkItems, groupByCategory } from "./workModel";

function item(partial: Partial<WorkItem> & Pick<WorkItem, "id" | "category">): WorkItem {
  return {
    source: "github",
    kind: "issue",
    title: "",
    repository: "",
    url: partial.id,
    state: "open",
    ...partial
  };
}

describe("workModel", () => {
  it("filters by title, repo, number, and labels (case-insensitive)", () => {
    const items = [
      item({ id: "1", category: "Assigned", title: "Fix login", repository: "acme/auth" }),
      item({ id: "2", category: "Assigned", title: "Docs", repository: "acme/site", number: 9 }),
      item({ id: "3", category: "Authored", title: "Perf", repository: "x/y", labels: ["urgent"] })
    ];
    expect(filterWorkItems(items, "login").map((i) => i.id)).toEqual(["1"]);
    expect(filterWorkItems(items, "ACME").map((i) => i.id)).toEqual(["1", "2"]);
    expect(filterWorkItems(items, "#9").map((i) => i.id)).toEqual(["2"]);
    expect(filterWorkItems(items, "urgent").map((i) => i.id)).toEqual(["3"]);
    expect(filterWorkItems(items, "   ")).toHaveLength(3);
  });

  it("groups into the canonical category order, with unknowns last", () => {
    const items = [
      item({ id: "1", category: "Review requested" }),
      item({ id: "2", category: "Assigned" }),
      item({ id: "3", category: "Zeta" }),
      item({ id: "4", category: "Authored" })
    ];
    expect(groupByCategory(items).map((g) => g.category)).toEqual([
      "Assigned",
      "Authored",
      "Review requested",
      "Zeta"
    ]);
  });
});
