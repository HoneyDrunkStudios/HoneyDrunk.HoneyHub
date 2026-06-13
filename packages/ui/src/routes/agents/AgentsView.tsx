import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { AgentDefinition } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { backendLabel } from "../../backends";
import { sortAgents } from "./agentsModel";

export interface AgentsViewProps {
  client: WireClient;
  /** The parent toggles this as the tab is shown/hidden so a hidden tab makes no
      host requests. */
  active: boolean;
}

/**
 * The agents catalog (packet 09 §3f-bis): the user's own agent definitions,
 * auto-discovered from `.claude/agents/` (Claude) and `.copilot/agents/` (Copilot) — the
 * per-workspace repo folders (within the workspace allowlist) and, when the host opts in,
 * the user-global home folders — and surfaced as runnable dispatch targets. Read-only — it
 * never authors
 * or mutates a definition. Definitions are deduped by **name** into one row runnable on
 * the set of backends that define it; each backend shows as a badge with its own metadata.
 * It asks the host to discover when the tab becomes active and listens for the
 * `agent_catalog` event.
 */
export function AgentsView({ client, active }: Readonly<AgentsViewProps>) {
  const [agents, setAgents] = useState<AgentDefinition[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.discoverAgents().catch(() => {
      // Generic message: a raw host/transport error can carry local-sensitive
      // detail, and everything here is sensitive by default (ADR-0090 D11).
      setError("could not discover agents");
      setLoading(false);
    });
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "agent_catalog") {
        setAgents(event.payload.agents);
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh]);

  const ordered = agents === undefined ? undefined : sortAgents(agents);

  let placeholder: ReactElement | null = null;
  if (loading) {
    placeholder = <p className="agents-empty">Discovering agents…</p>;
  } else if (error === undefined) {
    placeholder = <p className="agents-empty">No agents discovered yet.</p>;
  }

  return (
    <section className="agents" aria-label="Agents">
      <header className="agents-header">
        <h2>Agents</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "Discovering…" : "Refresh"}
        </button>
      </header>
      <p className="agents-scope">
        Discovered from your own <code>.claude/agents/</code> and <code>.copilot/agents/</code>{" "}
        folders in your allowlisted workspaces (and your user-global config, when the host
        enables it). Read-only — nothing here is changed.
      </p>

      {error !== undefined && (
        <p role="alert" className="agents-error">
          {error}
        </p>
      )}

      {ordered === undefined ? (
        placeholder
      ) : ordered.length === 0 ? (
        <p className="agents-empty">
          No agent definitions found. Add one under <code>.claude/agents/</code> or{" "}
          <code>.copilot/agents/</code> (in an allowlisted workspace or your home) and refresh.
        </p>
      ) : (
        <ul className="agents-list">
          {ordered.map((agent) => (
            <li key={agent.id} className="agent-card">
              <div className="agent-card-head">
                <span className="agent-name">{agent.name}</span>
                <span className="agent-backends">
                  {agent.backends.map((binding) => (
                    <span key={binding.backend} className="agent-backend-badge">
                      {backendLabel(binding.backend)}
                    </span>
                  ))}
                </span>
              </div>
              <ul className="agent-bindings">
                {agent.backends.map((binding) => (
                  <li key={binding.backend} className="agent-binding">
                    <span className="agent-binding-backend">{backendLabel(binding.backend)}</span>
                    {binding.model !== undefined && (
                      <span className="agent-model">{binding.model}</span>
                    )}
                    {binding.description !== "" && (
                      <p className="agent-description">{binding.description}</p>
                    )}
                    <p className="agent-source">
                      <span className="agent-scope">{binding.scope}</span>
                      {/* A global binding's label is the constant "global" sentinel, which
                          duplicates the scope — suppress it for global only. Gate on the
                          scope itself (not label === scope) so a *project* workspace that
                          happens to be named "global"/"project" still shows its label. */}
                      {binding.scope !== "global" && (
                        <span className="agent-workspace">{binding.workspaceLabel}</span>
                      )}
                      <span className="agent-path">{binding.sourcePath}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
