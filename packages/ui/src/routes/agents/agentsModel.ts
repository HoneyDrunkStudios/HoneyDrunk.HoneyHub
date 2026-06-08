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
    // Code-point comparison (not localeCompare) so the order is locale-independent
    // and matches the host's byte-order sort — the list never reorders by environment.
    agents: [...(byBackend.get(backend) ?? [])].sort(
      (left, right) => compare(left.name, right.name) || compare(left.id, right.id)
    )
  }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
