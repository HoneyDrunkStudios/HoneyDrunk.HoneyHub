import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AgentBackend, BackendCapability, Notification } from "@honeydrunk/honeyhub-types";
import { BridgeSettings } from "./BridgeSettings";
import { NotificationList } from "./NotificationList";
import { RunScreen } from "./routes/run/RunScreen";
import { SpendView } from "./routes/spend/SpendView";
import { CoachingView } from "./routes/coaching/CoachingView";
import { AgentsView } from "./routes/agents/AgentsView";
import { BrowseView } from "./routes/browse/BrowseView";
import { RunsView } from "./routes/runs/RunsView";
import {
  applyRunEvent,
  orderRuns,
  registerRun,
  type RunsState
} from "./routes/runs/runsModel";
import { GoalsView } from "./routes/goals/GoalsView";
import { GoalOrchestrator } from "./routes/goals/goalOrchestrator";
import { orderGoals, type GoalsState } from "./routes/goals/goalsModel";
import { enabledIds, loadConnectorPrefs } from "./connectors";
import { ChatDock } from "./routes/chat/ChatDock";
import { HubView } from "./routes/hub/HubView";
import { PlanView } from "./routes/plan/PlanView";
import { WorkView } from "./routes/work/WorkView";
import { ObserveView } from "./routes/observe/ObserveView";
import { JobsView } from "./routes/jobs/JobsView";
import { GitView } from "./routes/git/GitView";
import { UpdatesView } from "./routes/updates/UpdatesView";
import { Onboarding } from "./routes/onboarding/Onboarding";
import { emptyBridgeSettings, type BridgeSettingsState } from "./settingsModel";
import { loadProviderPrefs, saveProviderPrefs } from "./providerPrefs";
import { loadPlans, savePlans, type Plans } from "./plans";
import { MockWireClient } from "./wire/mockClient";
import { bridgeWsUrl, WebSocketWireClient } from "./wire/webSocketClient";
import type { WireClient } from "./wire/client";
import "./styles.css";

type View =
  | "hub"
  | "run"
  | "runs"
  | "goals"
  | "plan"
  | "work"
  | "jobs"
  | "observe"
  | "git"
  | "browse"
  | "spend"
  | "coaching"
  | "agents"
  | "settings"
  | "updates"
  | "notifications";

interface NavItem {
  view: View;
  label: string;
  icon: ReactElement;
}

// Two groups: the day-to-day surfaces, then the trust/plumbing surfaces. The
// sidebar keeps the primary work (Run) at the top and pushes config to the foot.
const PRIMARY_NAV: NavItem[] = [
  { view: "hub", label: "Hub", icon: <IconHome /> },
  { view: "run", label: "Chat", icon: <IconChat /> },
  { view: "runs", label: "Runs", icon: <IconRuns /> },
  { view: "goals", label: "Goals", icon: <IconTarget /> },
  { view: "plan", label: "Plan", icon: <IconMap /> },
  { view: "work", label: "Work", icon: <IconInbox /> },
  { view: "jobs", label: "Jobs", icon: <IconPulse /> },
  { view: "observe", label: "Observe", icon: <IconGauge /> },
  { view: "browse", label: "Browse", icon: <IconFiles /> },
  { view: "git", label: "Git", icon: <IconBranch /> },
  { view: "spend", label: "Spend", icon: <IconCoins /> },
  { view: "coaching", label: "Coaching", icon: <IconSpark /> },
  { view: "agents", label: "Agents", icon: <IconGrid /> }
];
const SECONDARY_NAV: NavItem[] = [
  { view: "settings", label: "Settings", icon: <IconGear /> },
  { view: "updates", label: "Updates", icon: <IconDownload /> },
  { view: "notifications", label: "Alerts", icon: <IconBell /> }
];

export interface AppProps {
  // Injectable so tests (and a future real WebSocket client) can supply their own
  // transport; defaults to the offline mock that scripts a Claude Code exchange.
  client?: WireClient;
}

export function App({ client }: AppProps = {}) {
  // Land on the Hub when the operator has connectors wired (the daily-driver glance);
  // otherwise default to Chat (a fresh install has an empty Hub, so Chat is more useful).
  const [view, setView] = useState<View>(() => {
    const prefs = loadConnectorPrefs();
    const hasConnectors =
      enabledIds(prefs, "work").length > 0 || enabledIds(prefs, "observability").length > 0;
    return hasConnectors ? "hub" : "run";
  });
  // The active transport. Defaults to the offline mock (a scripted demo); the
  // operator can connect to a real bridge host by pasting the cockpit URL it
  // prints, which swaps in the WebSocket client behind the same seam.
  const [wireClient, setWireClient] = useState<WireClient>(() => client ?? new MockWireClient());
  const [bridgeUrl, setBridgeUrl] = useState("");
  // A caller-provided client counts as connected; otherwise we start on the mock.
  const [connected, setConnected] = useState(client !== undefined);
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  // Persisted provider preferences: whether first-run selection is done and which
  // backends are enabled. Seeds the bridge settings' backend allowlist.
  const [persisted] = useState(loadProviderPrefs);
  const [onboarded, setOnboarded] = useState(persisted.onboarded);
  // Subscription plans (cost-optimizer input). Loaded once, held here, and passed to the
  // run screen so the router can treat flat-rate subs as effectively free. Persisted on
  // change, like provider prefs.
  const [plans, setPlans] = useState<Plans>(loadPlans);
  // Bridge settings are owned here so the run screen can read the workspace
  // allowlist the operator edits in Bridge settings. The backend allowlist is
  // seeded from the persisted provider selection.
  const [settings, setSettings] = useState<BridgeSettingsState>(() => ({
    ...emptyBridgeSettings,
    backends: persisted.enabled,
    enabledModels: persisted.enabledModels,
    workspaceRoots: persisted.workspaceRoots
  }));
  // The detected backend catalog (which CLIs are installed + their models), fetched
  // from the bridge on connect. Drives onboarding + the run-screen pickers.
  const [catalog, setCatalog] = useState<BackendCapability[]>([]);
  const [detecting, setDetecting] = useState(true);
  // Notifications arrive from the bridge once the transport surfaces them; the
  // surface itself is ready now.
  const [notifications] = useState<Notification[]>([]);
  // Every run's live summary (status/model/cost), aggregated from the bridge event
  // stream — the active-runs dashboard. Runs are registered at launch (for task +
  // backend) and updated as their events arrive.
  const [runs, setRuns] = useState<RunsState>({});
  // Active goals (bounded orchestration loops). Driven by the orchestrator below, which
  // launches their runs over the same transport and feeds them onto the runs board.
  const [goals, setGoals] = useState<GoalsState>({});
  const orchestratorRef = useRef<GoalOrchestrator | undefined>(undefined);

  // Aggregate all run events into the runs dashboard, whatever transport is active.
  useEffect(() => {
    const unsubscribe = wireClient.subscribe((event) => {
      setRuns((prev) => applyRunEvent(prev, event));
    });
    return unsubscribe;
  }, [wireClient]);

  // The goal orchestrator follows the active transport: re-created when the client swaps
  // (mock → real), disposed on cleanup so it never leaks a subscription. Each goal's runs
  // are registered onto the dashboard exactly like chat runs.
  useEffect(() => {
    const orchestrator = new GoalOrchestrator(wireClient, {
      onChange: (next) => setGoals(next),
      onRunStarted: (init) => setRuns((prev) => registerRun(prev, init)),
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID()
    });
    orchestratorRef.current = orchestrator;
    setGoals(orchestrator.list());
    return () => {
      orchestrator.dispose();
      orchestratorRef.current = undefined;
    };
  }, [wireClient]);

  // Ask the bridge which backends are installed (and their models) whenever the
  // transport changes (mock → real). The answer arrives as a `backend_catalog`
  // server event, so subscribe before requesting.
  useEffect(() => {
    setDetecting(true);
    const unsubscribe = wireClient.subscribe((event) => {
      if (event.payload.kind === "backend_catalog") {
        setCatalog(event.payload.backends);
        setDetecting(false);
      }
    });
    void wireClient.discoverBackends().catch(() => setDetecting(false));
    return unsubscribe;
  }, [wireClient]);

  // Persist the onboarding flag + enabled backends/models + repo locations whenever
  // they change, so the first-run screen does not reappear and the selection survives
  // a relaunch.
  useEffect(() => {
    saveProviderPrefs({
      onboarded,
      enabled: settings.backends,
      enabledModels: settings.enabledModels,
      workspaceRoots: settings.workspaceRoots
    });
  }, [onboarded, settings.backends, settings.enabledModels, settings.workspaceRoots]);

  // Persist subscription plans whenever they change, so the cost optimizer keeps
  // reflecting what the user actually pays across relaunches.
  useEffect(() => {
    savePlans(plans);
  }, [plans]);

  // Sync the picked repo locations to the bridge so file reads (and launches) are
  // scoped to them. Re-sent whenever the transport changes (connect) or the roots do.
  useEffect(() => {
    void wireClient.setWorkspaceRoots(settings.workspaceRoots).catch(() => undefined);
  }, [wireClient, settings.workspaceRoots]);

  const completeOnboarding = (enabled: AgentBackend[], roots: string[], chosenPlans: Plans) => {
    setSettings((prev) => ({ ...prev, backends: enabled, workspaceRoots: roots }));
    setPlans(chosenPlans);
    setOnboarded(true);
  };

  // When the bridge host serves this page (same origin, `?token=` in the URL),
  // connect automatically so launching the host is the only step.
  useEffect(() => {
    if (client !== undefined) {
      return;
    }
    const token = new URLSearchParams(globalThis.location.search).get("token");
    if (token === null || token.length === 0) {
      return;
    }
    try {
      setWireClient(WebSocketWireClient.connect(bridgeWsUrl(globalThis.location, token)));
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

  const renderNav = (items: NavItem[]) =>
    items.map((item) => (
      <button
        key={item.view}
        type="button"
        className="nav-item"
        aria-pressed={view === item.view}
        onClick={() => setView(item.view)}
      >
        <span className="nav-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="nav-label">{item.label}</span>
      </button>
    ));

  // First launch (or after a reset): the provider-selection screen replaces the
  // cockpit until the user confirms which backends they have.
  if (!onboarded) {
    return (
      <Onboarding
        client={wireClient}
        catalog={catalog}
        detecting={detecting}
        initialEnabled={settings.backends}
        initialRoots={settings.workspaceRoots}
        initialPlans={plans}
        onComplete={completeOnboarding}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="HoneyHub navigation">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            <img className="brand-logo" src={`${import.meta.env.BASE_URL}icons/icon-512.svg`} alt="" />
          </span>
          <span className="brand-text">
            <h1 className="brand-name">HoneyHub</h1>
          </span>
        </div>

        <nav className="sidebar-nav" aria-label="Primary views">
          {renderNav(PRIMARY_NAV)}
        </nav>

        <div className="sidebar-spacer" />

        <nav className="sidebar-nav secondary" aria-label="Configuration">
          {renderNav(SECONDARY_NAV)}
        </nav>

        <div className="sidebar-footer">
          <div className={`conn-state ${connected ? "is-connected" : "is-mock"}`}>
            <span className="conn-dot" aria-hidden="true" />
            <span>{connected ? "Connected" : "Demo (mock)"}</span>
          </div>
          {!connected && (
            <div className="bridge-connect">
              <input
                aria-label="Bridge URL"
                value={bridgeUrl}
                onChange={(event) => setBridgeUrl(event.target.value)}
                placeholder="ws://127.0.0.1:8765/ws?token=…"
              />
              <button type="button" onClick={onConnect}>
                Connect
              </button>
              {connectError !== undefined && (
                <span role="alert" className="settings-error">
                  {connectError}
                </span>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="content">
        <div className="content-inner">
          {/* Both panels stay mounted; visibility is toggled so in-progress state
              survives a tab switch. */}
          <div hidden={view !== "hub"}>
            <HubView
              client={wireClient}
              active={view === "hub"}
              onNavigate={(next) => setView(next)}
            />
          </div>

          <div hidden={view !== "run"}>
            <RunScreen
              client={wireClient}
              workspaceRoots={settings.workspaceRoots}
              availableBackends={settings.backends}
              catalog={catalog}
              enabledModels={settings.enabledModels}
              plans={plans}
              onAddWorkspaceRoots={(paths) =>
                setSettings((prev) => {
                  const next = [...prev.workspaceRoots];
                  for (const path of paths) {
                    if (!next.includes(path)) {
                      next.push(path);
                    }
                  }
                  return { ...prev, workspaceRoots: next };
                })
              }
              onRunStarted={(init) => setRuns((prev) => registerRun(prev, init))}
            />
          </div>

          <div hidden={view !== "runs"}>
            <RunsView runs={orderRuns(runs)} />
          </div>

          <div hidden={view !== "goals"}>
            <GoalsView
              goals={orderGoals(goals)}
              backends={settings.backends.length > 0 ? settings.backends : ["claude.local"]}
              onCreate={(input) => orchestratorRef.current?.start(input)}
              onPause={(goalId) => orchestratorRef.current?.pause(goalId)}
              onResume={(goalId) => orchestratorRef.current?.resume(goalId)}
              onStop={(goalId) => orchestratorRef.current?.stop(goalId)}
            />
          </div>

          <div hidden={view !== "plan"}>
            <PlanView client={wireClient} active={view === "plan"} />
          </div>

          <div hidden={view !== "work"}>
            <WorkView client={wireClient} active={view === "work"} />
          </div>

          <div hidden={view !== "observe"}>
            <ObserveView client={wireClient} active={view === "observe"} />
          </div>

          <div hidden={view !== "jobs"}>
            <JobsView client={wireClient} active={view === "jobs"} />
          </div>

          <div hidden={view !== "browse"}>
            <BrowseView
              client={wireClient}
              workspaceRoots={settings.workspaceRoots}
              active={view === "browse"}
            />
          </div>

          <div hidden={view !== "git"}>
            <GitView
              client={wireClient}
              active={view === "git"}
              workspaceRoots={settings.workspaceRoots}
            />
          </div>

          <div hidden={view !== "spend"}>
            <SpendView client={wireClient} active={view === "spend"} />
          </div>

          <div hidden={view !== "coaching"}>
            <CoachingView client={wireClient} active={view === "coaching"} />
          </div>

          <div hidden={view !== "agents"}>
            <AgentsView
              client={wireClient}
              active={view === "agents"}
              workspaceRoots={settings.workspaceRoots}
            />
          </div>

          <div hidden={view !== "settings"}>
            <BridgeSettings
              state={settings}
              onChange={setSettings}
              catalog={catalog}
              client={wireClient}
              active={view === "settings"}
              plans={plans}
              onPlansChange={setPlans}
            />
          </div>

          <div hidden={view !== "updates"}>
            <UpdatesView client={wireClient} active={view === "updates"} catalog={catalog} />
          </div>

          <div hidden={view !== "notifications"}>
            <NotificationList notifications={notifications} />
          </div>
        </div>
      </main>

      {/* Floating quick-chat: always mounted (so the conversation survives tab switches),
          hidden on the full Chat tab where it would just double up. */}
      <ChatDock
        client={wireClient}
        hidden={view === "run"}
        availableBackends={settings.backends}
        workspaceRoots={settings.workspaceRoots}
        catalog={catalog}
      />
    </div>
  );
}

/* --- Inline icons (no icon dependency; honey-tinted via currentColor) --- */

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5h16a1 1 0 011 1v10a1 1 0 01-1 1H9l-4 4v-4H4a1 1 0 01-1-1V6a1 1 0 011-1z" strokeLinejoin="round" />
    </svg>
  );
}

function IconRuns() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
      <circle cx="7" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="11" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="8" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconTarget() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconInbox() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
      <path d="M4 13h4l1.5 2.5h5L16 13h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconGauge() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 18a8 8 0 1 1 16 0" strokeLinecap="round" />
      <path d="M12 14l4-3" strokeLinecap="round" />
      <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 11l8-6 8 6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10v9h12v-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBranch() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-6 2.5-6 5.5" strokeLinecap="round" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h4l2 6 4-14 2 8h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMap() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" strokeLinejoin="round" />
      <path d="M9 4v14M15 6v14" />
    </svg>
  );
}

function IconFiles() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5v-11z" strokeLinejoin="round" />
    </svg>
  );
}

function IconCoins() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="9" cy="7" rx="6" ry="3" />
      <path d="M3 7v5c0 1.66 2.69 3 6 3s6-1.34 6-3V7" />
      <path d="M9 15v2c0 1.66 2.69 3 6 3s6-1.34 6-3v-5c0-1.3-1.64-2.4-4-2.83" />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" strokeLinecap="round" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.7 21a2 2 0 01-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
