import { useCallback, useEffect, useState } from "react";
import type { UsageSummary } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { backendLabel, fidelityNote, groundedHeadline, hasSpend, rollupCost } from "./spendModel";

export interface SpendViewProps {
  client: WireClient;
  /** When false the view stays mounted but does not poll; the parent toggles this
      as the tab is shown/hidden so a hidden Spend tab makes no host requests. */
  active: boolean;
}

/**
 * The "your spend" view (ADR-0092 D2 cost view): a device-wide, local-only rollup
 * of usage per backend. It asks the host for a fresh summary when the tab becomes
 * active (and on demand via Refresh), listens for the `usage_summary` event, and
 * renders grounded dollars separately from estimated activity so a guess can never
 * read as a measured cost.
 */
export function SpendView({ client, active }: Readonly<SpendViewProps>) {
  const [summary, setSummary] = useState<UsageSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.requestUsageSummary().catch(() => {
      // Keep the surfaced error generic: a raw host/transport error can carry
      // local-sensitive detail (paths, command lines), and everything here is
      // sensitive by default (ADR-0090 D11).
      setError("could not load spend");
      setLoading(false);
    });
  }, [client]);

  // Capture the summary as it streams back through the event seam.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "usage_summary") {
        setSummary(event.payload.summary);
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  // Refresh when the tab becomes active (the parent flips `active`).
  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh]);

  return (
    <section className="spend" aria-label="Your spend">
      <header className="spend-header">
        <h2>Your spend</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <p className="spend-scope">
        Local only — every figure below is computed on this device and never leaves it.
      </p>

      {error !== undefined && (
        <p role="alert" className="spend-error">
          {error}
        </p>
      )}

      <SpendBody summary={summary} loading={loading} error={error} />
    </section>
  );
}

interface SpendBodyProps {
  summary: UsageSummary | undefined;
  loading: boolean;
  error: string | undefined;
}

/** The body of the spend view: loading/empty placeholders until a summary lands,
    then either the empty-device copy or the full per-backend breakdown. Split out
    so the screen-level component stays flat. */
function SpendBody({ summary, loading, error }: Readonly<SpendBodyProps>) {
  if (summary === undefined) {
    // No summary yet: show the loading copy only while a request is in flight, so a
    // failed load (error shown above) doesn't read as still-loading.
    if (loading) {
      return <p className="spend-empty">Loading your spend…</p>;
    }
    if (error === undefined) {
      return <p className="spend-empty">No spend data yet.</p>;
    }
    return null;
  }

  if (hasSpend(summary)) {
    return <SpendSummary summary={summary} />;
  }

  return (
    <p className="spend-empty">No usage recorded yet. Run an agent and it shows up here.</p>
  );
}

/** The full breakdown shown once a non-empty summary is in hand. */
function SpendSummary({ summary }: Readonly<{ summary: UsageSummary }>) {
  const headline = groundedHeadline(summary);
  const turnSuffix = summary.totalTurns === 1 ? "" : "s";
  const sessionSuffix = summary.sessionCount === 1 ? "" : "s";

  return (
    <>
      <dl className="spend-totals">
        <div>
          <dt>Measured spend</dt>
          <dd className="spend-headline">
            {headline ?? "no measured spend yet"}
          </dd>
        </div>
        {summary.totalPremiumRequests > 0 && (
          <div>
            <dt>Premium requests</dt>
            <dd>{summary.totalPremiumRequests.toLocaleString()}</dd>
          </div>
        )}
        <div>
          <dt>Activity</dt>
          <dd>
            {summary.totalTurns.toLocaleString()} turn
            {turnSuffix} ·{" "}
            {summary.sessionCount.toLocaleString()} session
            {sessionSuffix}
          </dd>
        </div>
      </dl>

      <table className="spend-table">
        <caption className="spend-table-caption">Per backend</caption>
        <thead>
          <tr>
            <th scope="col">Backend</th>
            <th scope="col">Cost</th>
            <th scope="col">Tokens</th>
            <th scope="col">Turns</th>
          </tr>
        </thead>
        <tbody>
          {summary.rollups.map((rollup) => (
            <tr key={`${rollup.backend}-${rollup.fidelity}`}>
              <th scope="row">
                {backendLabel(rollup.backend)}
                <span className="fidelity-tag"> {fidelityNote(rollup.fidelity)}</span>
              </th>
              <td>{rollupCost(rollup)}</td>
              <td>{rollup.totalTokens.toLocaleString()}</td>
              <td>{rollup.turnCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="spend-note">
        Measured spend counts Claude (exact) and Codex (rate-derived) dollars only.
        Copilot bills premium requests, so its activity is shown separately and never
        folded into the dollar figure.
      </p>
    </>
  );
}
