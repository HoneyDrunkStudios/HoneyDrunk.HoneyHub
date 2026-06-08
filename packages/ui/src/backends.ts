import type { AgentBackend } from "@honeydrunk/honeyhub-types";

// Shared, human-facing label for a backend id. Centralized so the spend, coaching,
// and agents surfaces never diverge on what to call a backend.

const BACKEND_LABELS: Record<AgentBackend, string> = {
  "claude.local": "Claude Code",
  "codex.local": "Codex",
  "copilot.local": "Copilot"
};

export function backendLabel(backend: AgentBackend): string {
  return BACKEND_LABELS[backend] ?? backend;
}
