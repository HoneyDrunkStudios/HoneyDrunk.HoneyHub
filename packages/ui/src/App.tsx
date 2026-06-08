import { useEffect, useState } from "react";
import type { Notification } from "@honeydrunk/honeyhub-types";
import { BridgeSettings } from "./BridgeSettings";
import { NotificationList } from "./NotificationList";
import { RunScreen } from "./routes/run/RunScreen";
import { SpendView } from "./routes/spend/SpendView";
import { CoachingView } from "./routes/coaching/CoachingView";
import { AgentsView } from "./routes/agents/AgentsView";
import { emptyBridgeSettings, type BridgeSettingsState } from "./settingsModel";
import { MockWireClient } from "./wire/mockClient";
import { bridgeWsUrl, WebSocketWireClient } from "./wire/webSocketClient";
import type { WireClient } from "./wire/client";
import "./styles.css";

type View = "run" | "spend" | "coaching" | "agents" | "settings" | "notifications";

export interface AppProps {
  // Injectable so tests (and a future real WebSocket client) can supply their own
  // transport; defaults to the offline mock that scripts a Claude Code exchange.
  client?: WireClient;
}

export function App({ client }: AppProps = {}) {
  const [view, setView] = useState<View>("run");
  // The active transport. Defaults to the offline mock (a scripted demo); the
  // operator can connect to a real bridge host by pasting the cockpit URL it
  // prints, which swaps in the WebSocket client behind the same seam.
  const [wireClient, setWireClient] = useState<WireClient>(() => client ?? new MockWireClient());
  const [bridgeUrl, setBridgeUrl] = useState("");
  // A caller-provided client counts as connected; otherwise we start on the mock.
  const [connected, setConnected] = useState(client !== undefined);
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  // Bridge settings are owned here so the run screen can read the workspace
  // allowlist the operator edits in Bridge settings.
  const [settings, setSettings] = useState<BridgeSettingsState>(emptyBridgeSettings);
  // Notifications arrive from the bridge once the transport surfaces them; the
  // surface itself is ready now.
  const [notifications] = useState<Notification[]>([]);

  // When the bridge host serves this page (same origin, `?token=` in the URL),
  // connect automatically so launching the host is the only step.
  useEffect(() => {
    if (client !== undefined) {
      return;
    }
    const token = new URLSearchParams(window.location.search).get("token");
    if (token === null || token.length === 0) {
      return;
    }
    try {
      setWireClient(WebSocketWireClient.connect(bridgeWsUrl(window.location, token)));
      setConnected(true);
    } catch {
      // Leave the manual connect control available.
    }
  }, [client]);

  const onConnect = () => {
    const url = bridgeUrl.trim();
    if (url.length === 0) {
      return;
    }
    try {
      setWireClient(WebSocketWireClient.connect(url));
      setConnected(true);
      setConnectError(undefined);
    } catch (cause) {
      setConnected(false);
      setConnectError(cause instanceof Error ? cause.message : "could not connect");
    }
  };

  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="HoneyHub session overview">
        <div>
          <p className="eyebrow">HoneyHub</p>
          <h1>Agent Cockpit</h1>
        </div>
        <div className="bridge-connect">
          <input
            aria-label="Bridge URL"
            value={bridgeUrl}
            onChange={(event) => setBridgeUrl(event.target.value)}
            placeholder="ws://127.0.0.1:8765/ws?token=… (from the bridge host)"
          />
          <button type="button" onClick={onConnect}>
            Connect
          </button>
          <span className="connect-state">{connected ? "connected" : "demo (mock)"}</span>
          {connectError !== undefined && (
            <span role="alert" className="settings-error">
              {connectError}
            </span>
          )}
        </div>
      </section>

      <nav className="view-tabs" aria-label="HoneyHub views">
        <button type="button" aria-pressed={view === "run"} onClick={() => setView("run")}>
          Run
        </button>
        <button type="button" aria-pressed={view === "spend"} onClick={() => setView("spend")}>
          Spend
        </button>
        <button
          type="button"
          aria-pressed={view === "coaching"}
          onClick={() => setView("coaching")}
        >
          Coaching
        </button>
        <button type="button" aria-pressed={view === "agents"} onClick={() => setView("agents")}>
          Agents
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
        <RunScreen client={wireClient} workspaceRoots={settings.workspaceRoots} />
      </div>

      <div hidden={view !== "spend"}>
        <SpendView client={wireClient} active={view === "spend"} />
      </div>

      <div hidden={view !== "coaching"}>
        <CoachingView client={wireClient} active={view === "coaching"} />
      </div>

      <div hidden={view !== "agents"}>
        <AgentsView client={wireClient} active={view === "agents"} />
      </div>

      <div hidden={view !== "settings"}>
        <BridgeSettings state={settings} onChange={setSettings} />
      </div>

      <div hidden={view !== "notifications"}>
        <NotificationList notifications={notifications} />
      </div>
    </main>
  );
}
