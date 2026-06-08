import type { AgentBackend, AgentDefinition } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";

// Pure helpers for the agents catalog (packet 09 §3f-bis). The host discovers the
// definitions; these only group + order them for display.

export interface AgentGroup {
  backend: AgentBackend;
  label: string;
  agents: AgentDefinition[];
}

// Display order mirrors the rest of the cockpit (Claude, Codex, Copilot).
const BACKEND_ORDER: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];

/** Group discovered agents by backend in a stable order; within a group, sort by
    name then id so the list never reorders between identical catalogs. */
export function groupAgents(agents: AgentDefinition[]): AgentGroup[] {
  const byBackend = new Map<AgentBackend, AgentDefinition[]>();
  for (const agent of agents) {
    const list = byBackend.get(agent.backend) ?? [];
    list.push(agent);
    byBackend.set(agent.backend, list);
  }
  return BACKEND_ORDER.filter((backend) => byBackend.has(backend)).map((backend) => ({
    backend,
    label: backendLabel(backend),
    agents: [...(byBackend.get(backend) ?? [])].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    )
  }));
}
