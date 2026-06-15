import { describe, expect, it } from "vitest";
import {
  availableSlashCommands,
  filterSlashCommands,
  isSlashQuery,
  slashQuery,
  type SlashContext
} from "./slashCommands";

const baseCtx: SlashContext = {
  provider: "claude.local",
  costMode: "optimize",
  agents: [],
  effortLevels: []
};

describe("slashCommands", () => {
  it("detects a slash query and extracts its text", () => {
    expect(isSlashQuery("/mod")).toBe(true);
    expect(isSlashQuery("do a thing")).toBe(false);
    expect(slashQuery("/Model")).toBe("model");
  });

  it("offers /model in optimize mode and /optimize in manual mode", () => {
    const optimize = availableSlashCommands(baseCtx).map((c) => c.id);
    expect(optimize).toContain("model");
    expect(optimize).not.toContain("optimize");

    const manual = availableSlashCommands({ ...baseCtx, costMode: "manual" }).map((c) => c.id);
    expect(manual).toContain("optimize");
    expect(manual).not.toContain("model");
  });

  it("adds agent commands (Claude) and effort commands (Codex) from context", () => {
    const ctx: SlashContext = {
      provider: "codex.local",
      costMode: "manual",
      agents: ["reviewer"],
      effortLevels: ["low", "high"]
    };
    const ids = availableSlashCommands(ctx).map((c) => c.id);
    expect(ids).toContain("effort:low");
    expect(ids).toContain("effort:high");
    expect(ids).toContain("agent:reviewer");
  });

  it("always offers new + clear", () => {
    const ids = availableSlashCommands(baseCtx).map((c) => c.id);
    expect(ids).toContain("new");
    expect(ids).toContain("clear");
  });

  it("filters by label and hint, case-insensitively", () => {
    const ctx: SlashContext = {
      provider: "codex.local",
      costMode: "manual",
      agents: [],
      effortLevels: ["high"]
    };
    const all = availableSlashCommands(ctx);
    expect(filterSlashCommands(all, "eff").map((c) => c.id)).toEqual(["effort:high"]);
    // hint match: "/new" hint is "Start a new chat"
    expect(filterSlashCommands(all, "start").map((c) => c.id)).toContain("new");
    // empty query returns everything
    expect(filterSlashCommands(all, "").length).toBe(all.length);
  });
});
