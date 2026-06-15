import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { RoadmapItem, RoadmapSnapshot } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";

const DEFAULT_ARCH_NAME = "architecture";

export interface PlanViewProps {
  client: WireClient;
  active: boolean;
}

/**
 * Plan / Roadmap (control-hub #6): a read view of the HoneyDrunk Architecture repo's
 * `initiatives/current-focus.md`. Each lane (HoneyHub / NovOutbox / Curiosities) is a card
 * showing its ranked items and the first non-blocked one as **Next**. The bridge parses the
 * file; this polls + offers Refresh so it tracks the repo. When no Architecture repo is
 * found it shows directions naming the source files (the create action lands next).
 */
export function PlanView({ client, active }: Readonly<PlanViewProps>): ReactElement {
  const [snapshot, setSnapshot] = useState<RoadmapSnapshot | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const [pullError, setPullError] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    setLoading(true);
    client.roadmap().catch(() => setLoading(false));
  }, [client]);

  const pullLatest = useCallback(() => {
    setPullError(undefined);
    setLoading(true);
    client.pullArchitecture().catch((cause: unknown) => {
      setLoading(false);
      setPullError(cause instanceof Error ? cause.message : "could not pull");
    });
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "roadmap") {
        setSnapshot(event.payload.roadmap);
        setLoading(false);
        setCreating(false);
      }
    });
    return unsubscribe;
  }, [client]);

  const createArchitecture = useCallback(
    (name: string, location: string) => {
      setCreateError(undefined);
      setCreating(true);
      client
        .scaffoldArchitecture({
          ...(name.trim() !== "" ? { name: name.trim() } : {}),
          ...(location.trim() !== "" ? { location: location.trim() } : {})
        })
        .catch((cause: unknown) => {
          setCreating(false);
          setCreateError(cause instanceof Error ? cause.message : "could not create the repo");
        });
    },
    [client]
  );

  // Poll while the tab is open (+ on focus) so the roadmap tracks the repo, like Browse.
  useEffect(() => {
    if (!active) {
      return;
    }
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const interval = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [active, refresh]);

  return (
    <section className="plan" aria-label="Plan">
      <header className="plan-header">
        <div>
          <p className="eyebrow">Roadmap</p>
          <h2>What&rsquo;s next</h2>
        </div>
        <div className="plan-head-meta">
          {snapshot?.lastReviewed !== undefined && (
            <span className="plan-reviewed">reviewed {snapshot.lastReviewed}</span>
          )}
          {snapshot?.found === true && (
            <button type="button" onClick={pullLatest} disabled={loading}>
              Pull latest
            </button>
          )}
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </header>
      {pullError !== undefined && (
        <p role="alert" className="plan-pull-error">
          {pullError}
        </p>
      )}

      {snapshot === undefined ? (
        <p className="plan-empty">Reading the roadmap…</p>
      ) : !snapshot.found ? (
        <RoadmapEmptyState
          onCreate={createArchitecture}
          creating={creating}
          error={createError}
        />
      ) : snapshot.lanes.length === 0 ? (
        <p className="plan-empty">
          Found <code>current-focus.md</code> but no ranked lanes yet.
        </p>
      ) : (
        <div className="plan-board">
          {snapshot.lanes.map((lane) => (
            <div key={lane.lane} className="plan-lane">
              <h3 className="plan-lane-title">{lane.lane}</h3>
              {lane.next !== undefined && (
                <div className="plan-next">
                  <span className="plan-next-label">Next</span>
                  <span className="plan-next-item">{lane.next.item}</span>
                  <span className="plan-next-meta">
                    {lane.next.status}
                    {lane.next.due !== "" ? ` · ${lane.next.due}` : ""}
                  </span>
                </div>
              )}
              <ul className="plan-items">
                {lane.items.map((item) => (
                  <PlanItemRow key={`${item.rank}-${item.item}`} item={item} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PlanItemRow({ item }: Readonly<{ item: RoadmapItem }>): ReactElement {
  const blocked = item.blockedBy !== undefined;
  return (
    <li className={`plan-item ${blocked ? "is-blocked" : ""}`} title={item.whyNow ?? ""}>
      <span className="plan-rank">{item.rank}</span>
      <span className="plan-item-main">
        <span className="plan-item-title">{item.item}</span>
        <span className="plan-item-meta">
          {item.status}
          {item.due !== "" ? ` · ${item.due}` : ""}
          {blocked ? ` · blocked by ${item.blockedBy}` : ""}
        </span>
      </span>
    </li>
  );
}

interface RoadmapEmptyStateProps {
  onCreate: (name: string, location: string) => void;
  creating: boolean;
  error: string | undefined;
}

function RoadmapEmptyState({
  onCreate,
  creating,
  error
}: Readonly<RoadmapEmptyStateProps>): ReactElement {
  const [name, setName] = useState(DEFAULT_ARCH_NAME);
  const [location, setLocation] = useState("");
  return (
    <div className="plan-empty-state">
      <p>
        The roadmap reads a HoneyDrunk <strong>Architecture</strong> repo. None was found on
        this machine.
      </p>
      <p>It looks for these files (relative to the Architecture repo):</p>
      <ul className="plan-source-list">
        <li>
          <code>initiatives/current-focus.md</code> — the ranked lanes &amp; what&rsquo;s next
        </li>
        <li>
          <code>initiatives/programs/*.md</code> — per-lane detail
        </li>
        <li>
          <code>initiatives/roadmap.md</code> — the longer horizon
        </li>
      </ul>

      <form
        className="plan-create"
        aria-label="Create Architecture repo"
        onSubmit={(event) => {
          event.preventDefault();
          if (!creating) {
            onCreate(name, location);
          }
        }}
      >
        <p className="plan-create-title">Create a starter Architecture repo</p>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="architecture"
          />
        </label>
        <label>
          Location (optional)
          <input
            type="text"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Leave blank to create next to your workspace"
          />
        </label>
        {error !== undefined && (
          <p role="alert" className="plan-create-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={creating}>
          {creating ? "Creating…" : "Create Architecture repo"}
        </button>
      </form>

      <p className="plan-hint">
        Already have one? Point HoneyHub at it with <code>HONEYHUB_ARCHITECTURE_DIR</code>, or
        keep it as a sibling folder next to a workspace.
      </p>
    </div>
  );
}
