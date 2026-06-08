import { useState } from "react";
import type { DispatchRunState, Notification, UsageFidelity } from "@honeydrunk/honeyhub-types";
import { BridgeSettings } from "./BridgeSettings";
import { NotificationList } from "./NotificationList";
import "./styles.css";

const sampleState: DispatchRunState = "created";
const sampleFidelity: UsageFidelity = "exact";

type View = "run" | "settings" | "notifications";

export function App() {
  const [view, setView] = useState<View>("run");
  // Notifications arrive from the bridge once the run-screen transport is wired
  // (packet 08); the surface itself is ready now.
  const [notifications] = useState<Notification[]>([]);

  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="HoneyHub session overview">
        <div>
          <p className="eyebrow">HoneyHub</p>
          <h1>Agent Cockpit</h1>
        </div>
        <span className="status-pill">{sampleState}</span>
      </section>

      <nav className="view-tabs" aria-label="HoneyHub views">
        <button
          type="button"
          aria-pressed={view === "run"}
          onClick={() => setView("run")}
        >
          Run
        </button>
        <button
          type="button"
          aria-pressed={view === "settings"}
          onClick={() => setView("settings")}
        >
          Bridge settings
        </button>
        <button
          type="button"
          aria-pressed={view === "notifications"}
          onClick={() => setView("notifications")}
        >
          Notifications
        </button>
      </nav>

      {/* Both panels stay mounted; we toggle visibility so the bridge-settings
          model (paired devices, in-progress allowlist edits) survives a tab
          switch instead of being discarded on unmount. */}
      <section
        className="run-panel"
        aria-labelledby="run-title"
        hidden={view !== "run"}
      >
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

      <div hidden={view !== "settings"}>
        <BridgeSettings />
      </div>

      <div hidden={view !== "notifications"}>
        <NotificationList notifications={notifications} />
      </div>
    </main>
  );
}
