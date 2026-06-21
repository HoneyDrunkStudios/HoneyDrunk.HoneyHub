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
  /** The allowlisted workspace roots, so a new agent can target a project (one of
      these) or the user-global home (none). */
  workspaceRoots: string[];
}

/**
 * The agents catalog (packet 09 §3f-bis): the user's own agent definitions,
 * auto-discovered from `.claude/agents/` (Claude) and `.copilot/agents/` (Copilot) — the
 * per-workspace repo folders (within the workspace allowlist) and, when the host opts in,
 * the user-global home folders — and surfaced as runnable dispatch targets. Definitions
 * are deduped by **name** into one row runnable on the set of backends that define it;
 * each backend shows as a badge with its own metadata. New Claude agents can be authored
 * in-app (packet 09 §3d) via the form, which writes `.claude/agents/<name>.md` to a chosen
 * project or your home, then re-discovers. It asks the host to discover when the tab
 * becomes active and listens for the `agent_catalog` event.
 */
export function AgentsView({ client, active, workspaceRoots }: Readonly<AgentsViewProps>) {
  const [agents, setAgents] = useState<AgentDefinition[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

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
      } else if (event.payload.kind === "agent_written") {
        setNotice(`Created “${event.payload.agent.name}” (${event.payload.agent.sourcePath}).`);
        setCreating(false);
        // Pick up the newly authored definition.
        refresh();
      }
    });
    return unsubscribe;
  }, [client, refresh]);

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

  const emptyCatalog = (
    <p className="agents-empty">
      No agent definitions found. Add one under <code>.claude/agents/</code> or{" "}
      <code>.copilot/agents/</code> (in an allowlisted workspace or your home) and refresh.
    </p>
  );

  const catalog =
    ordered !== undefined && ordered.length > 0 ? (
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
    ) : (
      emptyCatalog
    );

  const createAgent = useCallback(
    (input: { name: string; description: string; body: string; model?: string; workspaceRoot?: string }) => {
      setError(undefined);
      setNotice(undefined);
      client
        .writeAgent(input)
        .catch(() => setError("could not create the agent"));
    },
    [client]
  );

  return (
    <section className="agents" aria-label="Agents">
      <header className="agents-header">
        <h2>Agents</h2>
        <div className="agents-actions">
          <button type="button" onClick={() => setCreating((open) => !open)}>
            {creating ? "Close" : "New agent"}
          </button>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Discovering…" : "Refresh"}
          </button>
        </div>
      </header>
      <p className="agents-scope">
        Discovered from your own <code>.claude/agents/</code> and <code>.copilot/agents/</code>{" "}
        folders in your allowlisted workspaces (and your user-global config, when the host
        enables it). Create a new Claude agent below; it is written to{" "}
        <code>.claude/agents/</code>.
      </p>

      {creating && (
        <NewAgentForm workspaceRoots={workspaceRoots} onSubmit={createAgent} />
      )}

      {notice !== undefined && (
        <output className="agents-notice">
          {notice}
        </output>
      )}

      {error !== undefined && (
        <p role="alert" className="agents-error">
          {error}
        </p>
      )}

      {ordered === undefined ? placeholder : catalog}
    </section>
  );
}

interface NewAgentFormProps {
  workspaceRoots: string[];
  onSubmit: (input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    workspaceRoot?: string;
  }) => void;
}

/** A name usable as a `.claude/agents/<name>.md` filename — letters, digits, `.`, `_`,
    `-`; not empty; not a dotfile. Mirrors the bridge's `validate_agent_name`. */
function isValidAgentName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.startsWith(".")) {
    return false;
  }
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

/** The author-an-agent form (packet 09 §3d). Writes a Claude agent definition to a
    chosen project root's `.claude/agents/` or, with "My home (global)", the user-global
    `~/.claude/agents/`. */
function NewAgentForm({ workspaceRoots, onSubmit }: Readonly<NewAgentFormProps>): ReactElement {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [body, setBody] = useState("");
  // "" sentinel = user-global home (no workspace root); otherwise the chosen root.
  const [target, setTarget] = useState("");

  const nameOk = isValidAgentName(name);
  const canSubmit = nameOk && description.trim().length > 0 && body.trim().length > 0;

  return (
    <form
      className="agent-form"
      aria-label="New agent"
      onSubmit={(form) => {
        form.preventDefault();
        if (!canSubmit) {
          return;
        }
        onSubmit({
          name: name.trim(),
          description: description.trim(),
          body,
          ...(model.trim().length > 0 ? { model: model.trim() } : {}),
          ...(target.length > 0 ? { workspaceRoot: target } : {})
        });
      }}
    >
      <label>
        Name{" "}
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="code-reviewer"
        />
      </label>
      {name.length > 0 && !nameOk && (
        <p className="agent-form-hint">
          Use letters, digits, <code>.</code>, <code>_</code>, <code>-</code> (no spaces or
          slashes).
        </p>
      )}
      <label>
        Description{" "}
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Reviews a diff against the Grid before a PR."
        />
      </label>
      <label>
        Model (optional){" "}
        <input
          type="text"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="opus"
        />
      </label>
      <label>
        Where{" "}
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">My home (global)</option>
          {workspaceRoots.map((root) => (
            <option key={root} value={root}>
              {root}
            </option>
          ))}
        </select>
      </label>
      <label>
        Instructions{" "}
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          placeholder="You are a focused agent that…"
        />
      </label>
      <button type="submit" disabled={!canSubmit}>
        Create agent
      </button>
    </form>
  );
}
