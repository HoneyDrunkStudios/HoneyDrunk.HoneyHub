import type { RunSummary } from "./runsModel";
import { isRunActive } from "./runsModel";
import { backendLabel } from "../../backends";

export interface RunsViewProps {
  runs: RunSummary[];
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** The active-runs dashboard: every run across repos/sessions on one board, with live
    status, model, and accumulated cost — the solo-multi-repo control surface. */
export function RunsView({ runs }: Readonly<RunsViewProps>) {
  const active = runs.filter(isRunActive).length;

  return (
    <section className="runs" aria-label="Runs">
      <header className="runs-header">
        <div>
          <p className="eyebrow">Runs</p>
          <h2>Active runs</h2>
        </div>
        <span className="runs-count">
          {active} active · {runs.length} total
        </span>
      </header>

      {runs.length === 0 ? (
        <p className="runs-empty">
          No runs yet. Start one from the Chat tab — they'll show here so you can watch
          everything at once.
        </p>
      ) : (
        <ul className="runs-list" aria-label="Run list">
          {runs.map((run) => (
            <li key={run.runId} className={`run-row state-${run.state}`}>
              <span className={`run-dot ${isRunActive(run) ? "is-active" : "is-done"}`} aria-hidden="true" />
              <span className="run-task" title={run.task}>
                {run.task}
              </span>
              <span className="run-backend">
                {run.backend !== undefined ? backendLabel(run.backend) : "—"}
                {run.model !== undefined ? ` · ${run.model}` : ""}
              </span>
              <span className="run-state-pill" aria-label="Run state">
                {run.needsInput ? "needs input" : run.state}
              </span>
              <span className="run-cost">{usd(run.totalUsd)}</span>
              {run.artifacts > 0 && (
                <span className="run-artifacts" title="artifacts produced">
                  ⬡ {run.artifacts}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
