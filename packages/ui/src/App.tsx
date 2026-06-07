import type { DispatchRunState, UsageFidelity } from "@honeydrunk/honeyhub-types";
import "./styles.css";

const sampleState: DispatchRunState = "created";
const sampleFidelity: UsageFidelity = "exact";

export function App() {
  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="HoneyHub session overview">
        <div>
          <p className="eyebrow">HoneyHub</p>
          <h1>Agent Cockpit</h1>
        </div>
        <span className="status-pill">{sampleState}</span>
      </section>

      <section className="run-panel" aria-labelledby="run-title">
        <div>
          <p className="eyebrow">Run</p>
          <h2 id="run-title">No active session</h2>
          <p className="body">
            Pair a local bridge, choose an allowlisted workspace, and start a Claude Code run. Bridge wiring lands in the Phase 2 run screen.
          </p>
        </div>
        <div className="usage-card" aria-label="Usage fidelity">
          <span>Usage</span>
          <strong>{sampleFidelity}</strong>
        </div>
      </section>
    </main>
  );
}
