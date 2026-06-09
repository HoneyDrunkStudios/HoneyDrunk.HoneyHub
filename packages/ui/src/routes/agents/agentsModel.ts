import type { AgentBackend, AgentBackendBinding, AgentDefinition } from "@honeydrunk/honeyhub-types";

// Pure helpers for the agents catalog (packet 09 §3f-bis). The host discovers the
// definitions and dedupes them by name into one entry runnable on the set of backends
// that define it; these only order them (and their backends) for display.

// Display order mirrors the rest of the cockpit (Claude, Codex, Copilot).
const BACKEND_ORDER: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];

/** Order discovered agents for display: by name, then id, so the list never reorders
    between identical catalogs. Code-point comparison (not localeCompare) so the order is
    locale-independent and matches the host's byte-order sort. */
export function sortAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return [...agents]
    .map((agent) => ({ ...agent, backends: sortBackends(agent.backends) }))
    .sort((left, right) => compare(left.name, right.name) || compare(left.id, right.id));
}

/** Order an agent's backend bindings in cockpit order so the badges/rows never reorder. */
export function sortBackends(backends: AgentBackendBinding[]): AgentBackendBinding[] {
  return [...backends].sort(
    (left, right) => backendRank(left.backend) - backendRank(right.backend)
  );
}

function backendRank(backend: AgentBackend): number {
  const index = BACKEND_ORDER.indexOf(backend);
  // An unknown backend sorts last (stable) rather than to the front.
  return index === -1 ? BACKEND_ORDER.length : index;
}

const encoder = new TextEncoder();

// Compare by UTF-8 bytes, not JS `<`/`>` (which order by UTF-16 code units). The host
// (Rust) sorts agent names/ids by their underlying UTF-8 bytes (`str::cmp` / a
// `BTreeMap<String, _>`), so for non-BMP names the two would otherwise diverge — this
// keeps the cockpit's order byte-for-byte identical to the host's.
function compare(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let i = 0; i < limit; i += 1) {
    const delta = leftBytes[i]! - rightBytes[i]!;
    if (delta !== 0) {
      return delta;
    }
  }
  return leftBytes.length - rightBytes.length;
}
