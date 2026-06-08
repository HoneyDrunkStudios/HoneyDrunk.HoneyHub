import { useMemo, useState } from "react";
import type { Notification } from "@honeydrunk/honeyhub-types";
import { BridgeSettings } from "./BridgeSettings";
import { NotificationList } from "./NotificationList";
import { RunScreen } from "./routes/run/RunScreen";
import { MockWireClient } from "./wire/mockClient";
import type { WireClient } from "./wire/client";
import "./styles.css";

type View = "run" | "settings" | "notifications";

export interface AppProps {
  // Injectable so tests (and a future real WebSocket client) can supply their own
  // transport; defaults to the offline mock that scripts a Claude Code exchange.
  client?: WireClient;
}

export function App({ client }: AppProps = {}) {
  const [view, setView] = useState<View>("run");
  const wireClient = useMemo(() => client ?? new MockWireClient(), [client]);
  // Notifications arrive from the bridge once the transport surfaces them; the
  // surface itself is ready now.
  const [notifications] = useState<Notification[]>([]);

  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="HoneyHub session overview">
        <div>
          <p className="eyebrow">HoneyHub</p>
          <h1>Agent Cockpit</h1>
        </div>
      </section>

      <nav className="view-tabs" aria-label="HoneyHub views">
        <button type="button" aria-pressed={view === "run"} onClick={() => setView("run")}>
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

      {/* Both panels stay mounted; visibility is toggled so in-progress state
          survives a tab switch. */}
      <div hidden={view !== "run"}>
        <RunScreen client={wireClient} />
      </div>

      <div hidden={view !== "settings"}>
        <BridgeSettings />
      </div>

      <div hidden={view !== "notifications"}>
        <NotificationList notifications={notifications} />
      </div>
    </main>
  );
}
