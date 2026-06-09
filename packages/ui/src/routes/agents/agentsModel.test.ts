import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentBackendBinding, AgentDefinition } from "@honeydrunk/honeyhub-types";
import { sortAgents, sortBackends } from "./agentsModel";

function binding(backend: AgentBackend): AgentBackendBinding {
  return {
    backend,
    description: "",
    sourcePath: `.x/${backend}.md`,
    scope: "project",
    workspaceLabel: "work"
  };
}

function agent(id: string, name: string, backends: AgentBackend[]): AgentDefinition {
  return { id, name, backends: backends.map(binding) };
}

describe("sortAgents", () => {
  it("orders agents by name then id, and each agent's backends in cockpit order", () => {
    const sorted = sortAgents([
      agent("z1", "Zeta", ["copilot.local", "claude.local"]),
      agent("a2", "Beta", ["claude.local"]),
      agent("a1", "Alpha", ["copilot.local"])
    ]);

    expect(sorted.map((a) => a.name)).toEqual(["Alpha", "Beta", "Zeta"]);
    // The multi-backend entry keeps both backends, reordered to cockpit order.
    expect(sorted[2]?.backends.map((b) => b.backend)).toEqual(["claude.local", "copilot.local"]);
  });

  it("returns empty for none and does not mutate its input", () => {
    expect(sortAgents([])).toEqual([]);
    const input = [agent("z", "Zeta", ["claude.local"]), agent("a", "Alpha", ["claude.local"])];
    sortAgents(input);
    expect(input.map((a) => a.name)).toEqual(["Zeta", "Alpha"]);
  });
});

describe("sortBackends", () => {
  it("orders bindings Claude, Codex, Copilot and puts unknown backends last", () => {
    const ordered = sortBackends([
      binding("copilot.local"),
      binding("codex.local"),
      binding("claude.local")
    ]);
    expect(ordered.map((b) => b.backend)).toEqual([
      "claude.local",
      "codex.local",
      "copilot.local"
    ]);
  });
});
