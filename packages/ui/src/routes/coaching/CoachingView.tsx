import { useCallback, useEffect, useState } from "react";
import type { PolicyHint } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { hintTitle, severityLabel, sortHints } from "./coachingModel";

export interface CoachingViewProps {
  client: WireClient;
  /** The parent toggles this as the tab is shown/hidden so a hidden tab makes no
      host requests. */
  active: boolean;
}

/**
 * The cross-session coaching surface (ADR-0092 D4 / packet 09 §3e): advisory,
 * rules-based hints (start a fresh session, watch a high-cost session, estimated
 * figures are approximate) rolled up across every session on the device. Advisory
 * only — the engine never emits a blocking action. It asks the host for fresh hints
 * when the tab becomes active, listens for the `coaching_hints` event, and renders
 * them severity-first.
 */
export function CoachingView({ client, active }: CoachingViewProps) {
  const [hints, setHints] = useState<PolicyHint[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.requestCoachingHints().catch(() => {
      // Generic message: a raw host/transport error can carry local-sensitive
      // detail, and everything here is sensitive by default (ADR-0090 D11).
      setError("could not load coaching");
      setLoading(false);
    });
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "coaching_hints") {
        setHints(event.payload.hints);
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

  const ordered = hints === undefined ? undefined : sortHints(hints);

  return (
    <section className="coaching" aria-label="Coaching">
      <header className="coaching-header">
        <h2>Coaching</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="coaching-scope">
        Advisory only — local suggestions computed on this device. Nothing here blocks a run.
      </p>

      {error !== undefined && (
        <p role="alert" className="coaching-error">
          {error}
        </p>
      )}

      {ordered === undefined ? (
        loading ? (
          <p className="coaching-empty">Loading coaching…</p>
        ) : error === undefined ? (
          <p className="coaching-empty">No coaching yet.</p>
        ) : null
      ) : ordered.length === 0 ? (
        <p className="coaching-empty">No advisories right now. Your sessions look healthy.</p>
      ) : (
        <ul className="coaching-list">
          {ordered.map((hint) => (
            <li key={hint.id} className={`coaching-hint severity-${hint.severity}`}>
              <div className="coaching-hint-head">
                <span className={`coaching-badge severity-${hint.severity}`}>
                  {severityLabel(hint.severity)}
                </span>
                <span className="coaching-hint-title">{hintTitle(hint.code)}</span>
              </div>
              <p className="coaching-hint-message">{hint.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
