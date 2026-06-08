import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentDefinition } from "@honeydrunk/honeyhub-types";
import { groupAgents } from "./agentsModel";

function agent(id: string, name: string, backend: AgentBackend): AgentDefinition {
  return {
    id,
    name,
    description: "",
    backend,
    sourcePath: `.x/${id}.md`,
    workspaceLabel: "work"
  };
}

describe("groupAgents", () => {
  it("groups by backend in cockpit order, sorting agents by name within a group", () => {
    const groups = groupAgents([
      agent("c1", "Zeta", "copilot.local"),
      agent("a2", "Beta", "claude.local"),
      agent("a1", "Alpha", "claude.local"),
      agent("c2", "Yara", "copilot.local")
    ]);

    expect(groups.map((g) => g.backend)).toEqual(["claude.local", "copilot.local"]);
    expect(groups[0]?.label).toBe("Claude Code");
    expect(groups[0]?.agents.map((a) => a.name)).toEqual(["Alpha", "Beta"]);
    expect(groups[1]?.agents.map((a) => a.name)).toEqual(["Yara", "Zeta"]);
  });

  it("omits backends with no agents and returns empty for none", () => {
    expect(groupAgents([])).toEqual([]);
    const groups = groupAgents([agent("a1", "Only", "claude.local")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.backend).toBe("claude.local");
  });
});
