import { useCallback, useEffect, useState } from "react";
import type { AgentDefinition } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { groupAgents } from "./agentsModel";

export interface AgentsViewProps {
  client: WireClient;
  /** The parent toggles this as the tab is shown/hidden so a hidden tab makes no
      host requests. */
  active: boolean;
}

/**
 * The agents catalog (packet 09 §3f-bis): the user's own agent definitions,
 * auto-discovered from `.claude/agents/` (Claude) and `.github/` (Copilot) within
 * the workspace allowlist, surfaced as runnable dispatch targets. Read-only — it
 * never authors or mutates a definition. It asks the host to discover when the tab
 * becomes active, listens for the `agent_catalog` event, and lists the agents
 * grouped by backend.
 */
export function AgentsView({ client, active }: AgentsViewProps) {
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

  const groups = agents === undefined ? undefined : groupAgents(agents);

  return (
    <section className="agents" aria-label="Agents">
      <header className="agents-header">
        <h2>Agents</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "Discovering…" : "Refresh"}
        </button>
      </header>
      <p className="agents-scope">
        Discovered from your own <code>.claude/agents/</code> and <code>.github/</code> files,
        within your allowlisted workspaces. Read-only — nothing here is changed.
      </p>

      {error !== undefined && (
        <p role="alert" className="agents-error">
          {error}
        </p>
      )}

      {groups === undefined ? (
        loading ? (
          <p className="agents-empty">Discovering agents…</p>
        ) : error === undefined ? (
          <p className="agents-empty">No agents discovered yet.</p>
        ) : null
      ) : groups.length === 0 ? (
        <p className="agents-empty">
          No agent definitions found. Add one under <code>.claude/agents/</code> in an
          allowlisted workspace and refresh.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.backend} className="agents-group">
            <h3 className="agents-group-label">{group.label}</h3>
            <ul className="agents-list">
              {group.agents.map((agent) => (
                <li key={agent.id} className="agent-card">
                  <div className="agent-card-head">
                    <span className="agent-name">{agent.name}</span>
                    {agent.model !== undefined && (
                      <span className="agent-model">{agent.model}</span>
                    )}
                  </div>
                  {agent.description !== "" && (
                    <p className="agent-description">{agent.description}</p>
                  )}
                  <p className="agent-source">
                    <span className="agent-workspace">{agent.workspaceLabel}</span>
                    <span className="agent-path">{agent.sourcePath}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
