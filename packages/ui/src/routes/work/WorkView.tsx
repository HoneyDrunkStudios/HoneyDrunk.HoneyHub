import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { WorkSnapshot } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { enabledIds, KNOWN_CONNECTORS, loadConnectorPrefs } from "../../connectors";
import { formatRelative, useRelativeNow } from "../../relativeTime";
import { filterWorkItems, groupByCategory } from "./workModel";

export interface WorkViewProps {
  client: WireClient;
  /** The parent toggles this so a hidden tab makes no host requests. */
  active: boolean;
}

const SOURCE_LABEL: Record<string, string> = Object.fromEntries(
  KNOWN_CONNECTORS.map((connector) => [connector.id, connector.label])
);

/**
 * Work hub (connector-fed): everything assigned to you across the opt-in work connectors
 * (GitHub now; ADO next), searchable and split into clean category buckets. Read-only — every
 * item links out to its source. Queries ONLY the connectors you've enabled; with none enabled
 * it nudges you to Settings rather than fetching anything.
 */
export function WorkView({ client, active }: Readonly<WorkViewProps>): ReactElement {
  const [snapshot, setSnapshot] = useState<WorkSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const now = useRelativeNow(active);
  // Re-read prefs each activation so toggling a connector in Settings takes effect on return.
  const [sources, setSources] = useState<string[]>([]);

  const refresh = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        setSnapshot({ sources: [] });
        return;
      }
      setLoading(true);
      setError(undefined);
      client.listWork(ids).catch(() => {
        setError("could not read your work items");
        setLoading(false);
      });
    },
    [client]
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "work_snapshot") {
        setSnapshot(event.payload.snapshot);
        setUpdatedAt(Date.now());
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      const ids = enabledIds(loadConnectorPrefs(), "work");
      setSources(ids);
      refresh(ids);
    }
  }, [active, refresh]);

  const allItems = useMemo(
    () => (snapshot === undefined ? [] : snapshot.sources.flatMap((source) => source.items ?? [])),
    [snapshot]
  );
  const groups = useMemo(
    () => groupByCategory(filterWorkItems(allItems, query)),
    [allItems, query]
  );
  const unavailable = useMemo(
    () => (snapshot === undefined ? [] : snapshot.sources.filter((source) => !source.available)),
    [snapshot]
  );

  return (
    <section className="work" aria-label="Work">
      <header className="work-header">
        <h2>Work</h2>
        <div className="work-actions">
          {updatedAt !== undefined && (
            <span className="updated-stamp">updated {formatRelative(now, updatedAt)}</span>
          )}
          <input
            className="work-search"
            type="search"
            aria-label="Filter work items"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title, repo, label…"
          />
          <button type="button" onClick={() => refresh(sources)} disabled={loading || sources.length === 0}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </header>
      <p className="work-scope">
        Everything assigned to you across your connected tools — read-only. Each item opens in
        its source.
      </p>

      {error !== undefined && (
        <p role="alert" className="work-error">
          {error}
        </p>
      )}

      {unavailable.map((source) => (
        <p key={source.source} className="work-unavailable">
          {SOURCE_LABEL[source.source] ?? source.source}: {source.error ?? "not available"}
        </p>
      ))}

      {sources.length === 0 ? (
        <p className="work-empty">
          No work connectors enabled. Turn one on in <strong>Settings → Connectors</strong> to
          see your assigned issues and PRs here.
        </p>
      ) : snapshot === undefined ? (
        <p className="work-empty">{loading ? "Reading your work…" : "No snapshot yet."}</p>
      ) : groups.length === 0 ? (
        <p className="work-empty">
          {query.trim() === ""
            ? "Nothing assigned to you right now."
            : `No work items match “${query}”.`}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.category} className="work-group">
            <div className="work-group-head">
              <h3>{group.category}</h3>
              <span className="work-tally">{group.items.length}</span>
            </div>
            <ul className="work-list">
              {group.items.map((item) => (
                <li key={item.id} className={`work-item kind-${item.kind}`}>
                  <a className="work-item-title" href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <div className="work-item-meta">
                    <span className="work-repo">{item.repository}</span>
                    {item.number !== undefined && (
                      <span className="work-number">#{item.number}</span>
                    )}
                    <span className={`work-source-chip source-${item.source}`}>
                      {SOURCE_LABEL[item.source] ?? item.source}
                    </span>
                    {(item.labels ?? []).map((label) => (
                      <span key={label} className="work-label">
                        {label}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
