import { describe, expect, it } from "vitest";
import type { BackendCapability } from "@honeydrunk/honeyhub-types";
import { defaultClaudeCapabilities } from "@honeydrunk/honeyhub-types";
import {
  diffNewModels,
  hasNewModels,
  mergeSeen,
  newModelCount,
  type SeenModels
} from "./updatesModel";

function catalog(models: string[]): BackendCapability[] {
  return [
    {
      backend: "claude.local",
      program: "claude",
      available: true,
      capabilities: defaultClaudeCapabilities,
      models: models.map((id) => ({ id, label: id })),
      modelSource: "cli_alias"
    }
  ];
}

describe("updatesModel", () => {
  it("treats a never-seen backend as a baseline (no new models)", () => {
    const diff = diffNewModels(catalog(["opus", "sonnet"]), {});
    expect(hasNewModels(diff)).toBe(false);
    expect(newModelCount(diff)).toBe(0);
  });

  it("flags only models absent from the seen set", () => {
    const seen: SeenModels = { "claude.local": ["opus"] };
    const diff = diffNewModels(catalog(["opus", "sonnet", "haiku"]), seen);
    expect(diff["claude.local"]).toEqual(["sonnet", "haiku"]);
    expect(newModelCount(diff)).toBe(2);
  });

  it("mergeSeen unions current ids into the seen set without dropping old ones", () => {
    const seen: SeenModels = { "claude.local": ["opus", "retired-model"] };
    const next = mergeSeen(catalog(["opus", "sonnet"]), seen);
    expect(new Set(next["claude.local"])).toEqual(new Set(["opus", "retired-model", "sonnet"]));
  });

  it("after acknowledging, the same catalog yields no new models", () => {
    const seen0: SeenModels = { "claude.local": ["opus"] };
    const cat = catalog(["opus", "sonnet"]);
    expect(newModelCount(diffNewModels(cat, seen0))).toBe(1);
    const seen1 = mergeSeen(cat, seen0);
    expect(newModelCount(diffNewModels(cat, seen1))).toBe(0);
  });
});
