import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from "react";
import type { AgentBackend, BackendCapability } from "@honeydrunk/honeyhub-types";
import { NotificationList } from "./NotificationList";
import {
  loadNotificationFeed,
  loadNotificationPrefs,
  mergeFeed,
  saveNotificationFeed,
  saveNotificationPrefs,
  unreadCount,
  type AppNotification,
  type NotificationPrefs
} from "./notifications";
import { useNotifications } from "./useNotifications";
import { applyTheme, loadTheme, saveTheme, type ThemeId } from "./theme";
import { RunScreen } from "./routes/run/RunScreen";
import { SpendView } from "./routes/spend/SpendView";
import { CoachingView } from "./routes/coaching/CoachingView";
import { AgentsView } from "./routes/agents/AgentsView";
import { RepositoriesView } from "./routes/repositories/RepositoriesView";
import { RunsView } from "./routes/runs/RunsView";
import {
  applyRunEvent,
  orderRuns,
  registerRun,
  type RunsState
} from "./routes/runs/runsModel";
import { GroupsView } from "./routes/groups/GroupsView";
import { GoalsView } from "./routes/goals/GoalsView";
import { GoalOrchestrator } from "./routes/goals/goalOrchestrator";
import { orderGoals, type GoalsState } from "./routes/goals/goalsModel";
import { enabledIds, loadConnectorPrefs } from "./connectors";
import {
  isPageVisible,
  loadPagePrefs,
  savePagePrefs,
  TOGGLEABLE_PAGES,
  type PagePrefs
} from "./pagePrefs";
import { SettingsModal } from "./routes/settings/SettingsModal";
import {
  KV_SUBSCRIPTIONS_CHANGED_EVENT,
  loadSelectedSubscriptions
} from "./routes/observe/keyVaultModel";
import { ChatSidebar, SIDEBAR_SESSION_ID } from "./routes/chat/ChatSidebar";
import { HiveNav } from "./routes/nav/HiveNav";
import { MatrixRain } from "./components/MatrixRain";
import { HubView } from "./routes/hub/HubView";
import { PlanView } from "./routes/plan/PlanView";
import { WorkView } from "./routes/work/WorkView";
import { ObserveView } from "./routes/observe/ObserveView";
import { JobsView } from "./routes/jobs/JobsView";
import { UpdatesView } from "./routes/updates/UpdatesView";
import { Onboarding } from "./routes/onboarding/Onboarding";
import {
  emptyBridgeSettings,
  setDefaultWorkspaceRoot,
  type BridgeSettingsState
} from "./settingsModel";
import { loadProviderPrefs, saveProviderPrefs } from "./providerPrefs";
import { loadChatDockWidth, saveChatDockWidth } from "./chatDock";
import { loadPlans, savePlans, type Plans } from "./plans";
import { MockWireClient } from "./wire/mockClient";
import { bridgeWsUrl, WebSocketWireClient } from "./wire/webSocketClient";
import type { WireClient } from "./wire/client";
import "./styles.css";

export type View =
  | "hub"
  | "run"
  | "runs"
  | "groups"
  | "goals"
  | "plan"
  | "work"
  | "jobs"
  | "observe"
  | "repositories"
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
  /** Shown only in the small-screen layout (e.g. Chat, which desktop gets as the
      right-hand dock instead of a page). */
  mobileOnly?: boolean;
}

// Two groups: the day-to-day surfaces, then the trust/plumbing surfaces. The
// sidebar keeps the primary work (Run) at the top and pushes config to the foot.
const PRIMARY_NAV: NavItem[] = [
  { view: "hub", label: "Hub", icon: <IconHome /> },
  // On desktop the right-hand dock IS the chat; the Chat page exists for phones,
  // where the dock does not fit. The nav item is CSS-hidden on wide screens.
  { view: "run", label: "Chat", icon: <IconChat />, mobileOnly: true },
  { view: "runs", label: "Runs", icon: <IconRuns /> },
  { view: "groups", label: "Groups", icon: <IconGroups /> },
  { view: "goals", label: "Goals", icon: <IconTarget /> },
  { view: "plan", label: "Plan", icon: <IconMap /> },
  { view: "work", label: "Work", icon: <IconInbox /> },
  { view: "jobs", label: "Jobs", icon: <IconPulse /> },
  { view: "observe", label: "Observe", icon: <IconGauge /> },
  { view: "repositories", label: "Repositories", icon: <IconFiles /> },
  { view: "spend", label: "Spend", icon: <IconCoins /> },
  { view: "coaching", label: "Coaching", icon: <IconSpark /> },
  { view: "agents", label: "Agents", icon: <IconGrid /> }
];
// The config/trust surfaces. They live at the tail of the honeycomb (after the primary views),
// so every view is reachable from the one hive launcher.
const SECONDARY_NAV: NavItem[] = [
  { view: "settings", label: "Settings", icon: <IconGear /> },
  { view: "updates", label: "Updates", icon: <IconDownload /> },
  { view: "notifications", label: "Alerts", icon: <IconBell /> }
];
// The full nav list the honeycomb blooms into (day-to-day surfaces first, then config/trust),
// in display order. HiveNav filters it by page visibility.
const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

export interface AppProps {
  // Injectable so tests (and a future real WebSocket client) can supply their own
  // transport; defaults to the offline mock that scripts a Claude Code exchange.
  client?: WireClient;
}

export function App({ client }: AppProps = {}) {
  // Land on the Hub; chat lives in the always-available right-hand dock, so there is
  // no dedicated Chat page to land on anymore.
  const [view, setView] = useState<View>("hub");
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
  // Whether the right-hand chat dock is expanded (vs collapsed to a slim rail), and its
  // dragged width. Owned here so the shell grid can size its column to match; the width
  // persists like a real editor panel.
  const [chatOpen, setChatOpen] = useState(true);
  const [chatWidth, setChatWidth] = useState<number>(loadChatDockWidth);
  // Bridge settings are owned here so the run screen can read the workspace
  // allowlist the operator edits in Bridge settings. The backend allowlist is
  // seeded from the persisted provider selection.
  const [settings, setSettings] = useState<BridgeSettingsState>(() => ({
    ...emptyBridgeSettings,
    backends: persisted.enabled,
    enabledModels: persisted.enabledModels,
    workspaceRoots: persisted.workspaceRoots,
    ...(persisted.defaultWorkspaceRoot === undefined
      ? {}
      : { defaultWorkspaceRoot: persisted.defaultWorkspaceRoot })
  }));
  // The detected backend catalog (which CLIs are installed + their models), fetched
  // from the bridge on connect. Drives onboarding + the run-screen pickers.
  const [catalog, setCatalog] = useState<BackendCapability[]>([]);
  const [detecting, setDetecting] = useState(true);
  // Notification feed + per-type prefs (the notification engine fires into the feed and OS
  // toasts). Persisted across sessions.
  const [notifications, setNotifications] = useState<AppNotification[]>(loadNotificationFeed);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(loadNotificationPrefs);
  // The active theme (applied via a data-theme attribute on <html>). Applied on boot in
  // main.tsx; changes here re-apply + persist.
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  // The enabled connectors (work + observability), re-read when the view changes so editing
  // them in Settings → Connectors re-points the notification poll.
  const [connectorPrefs, setConnectorPrefs] = useState(loadConnectorPrefs);
  // Which nav pages the operator keeps in the sidebar. Toggled in Settings → Pages; Runs and
  // Goals default OFF (agent-first IDE reframe). Persisted like the other prefs.
  const [pagePrefs, setPagePrefs] = useState<PagePrefs>(loadPagePrefs);
  // The Key Vault subscription selection (owned by the Observe panel, persisted locally). Held in
  // state and re-read on view change so the expiry-scan engine reliably consumes the current
  // selection rather than a value captured at one render.
  const [keyVaultSubscriptions, setKeyVaultSubscriptions] = useState<string[]>(
    () => loadSelectedSubscriptions() ?? []
  );
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
      workspaceRoots: settings.workspaceRoots,
      ...(settings.defaultWorkspaceRoot === undefined
        ? {}
        : { defaultWorkspaceRoot: settings.defaultWorkspaceRoot })
    });
  }, [
    onboarded,
    settings.backends,
    settings.enabledModels,
    settings.workspaceRoots,
    settings.defaultWorkspaceRoot
  ]);

  // Persist subscription plans whenever they change, so the cost optimizer keeps
  // reflecting what the user actually pays across relaunches.
  useEffect(() => {
    savePlans(plans);
  }, [plans]);

  // Persist the notification feed + prefs.
  useEffect(() => {
    saveNotificationFeed(notifications);
  }, [notifications]);
  useEffect(() => {
    saveNotificationPrefs(notificationPrefs);
  }, [notificationPrefs]);

  // Apply + persist the theme whenever it changes.
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // Persist page-visibility prefs whenever they change, so a trimmed sidebar survives a relaunch.
  useEffect(() => {
    savePagePrefs(pagePrefs);
  }, [pagePrefs]);

  // If the currently-active page gets hidden (toggled off in Settings), fall back to the Hub so
  // the operator is never stranded on a page whose nav button just vanished. Core pages
  // (settings/updates/notifications, always-on) are exempt.
  useEffect(() => {
    const toggleable = TOGGLEABLE_PAGES.some((page) => page.view === view);
    if (toggleable && !isPageVisible(pagePrefs, view)) {
      setView("hub");
    }
  }, [view, pagePrefs]);

  // Opening the Alerts view marks everything read (so the unread badge clears when you look).
  // Idempotent — only rewrites when there's actually an unread item, so it can't loop.
  useEffect(() => {
    if (view === "notifications") {
      setNotifications((prev) =>
        prev.some((item) => !item.read) ? prev.map((item) => ({ ...item, read: true })) : prev
      );
    }
  }, [view, notifications]);

  // Re-read the enabled connectors when the view changes (so editing them in Settings →
  // Connectors re-points the notification engine's poll without a reload).
  useEffect(() => {
    setConnectorPrefs(loadConnectorPrefs());
    setKeyVaultSubscriptions(loadSelectedSubscriptions() ?? []);
  }, [view]);

  // Also react the moment the Key Vault selection changes (in the Observe panel), so the expiry
  // scan re-points without needing a view change. Pairs with the view-change re-read above.
  useEffect(() => {
    const onChange = (): void => setKeyVaultSubscriptions(loadSelectedSubscriptions() ?? []);
    globalThis.addEventListener?.(KV_SUBSCRIPTIONS_CHANGED_EVENT, onChange);
    return () => globalThis.removeEventListener?.(KV_SUBSCRIPTIONS_CHANGED_EVENT, onChange);
  }, []);

  // Whether the user is actively looking at a chat thread (so a finish there is silent). A
  // thread is "active" only when its surface is visible AND the window is focused.
  const isThreadActive = useCallback(
    (sessionId: string): boolean => {
      if (typeof document !== "undefined" && typeof document.hasFocus === "function" && !document.hasFocus()) {
        return false;
      }
      if (sessionId === "session-1") {
        return view === "run";
      }
      if (sessionId === SIDEBAR_SESSION_ID) {
        return view !== "run" && chatOpen;
      }
      return false;
    },
    [view, chatOpen]
  );

  // The notification engine: fires OS toasts + the in-app feed for chat-finished, work
  // assigned/mentioned, PR-review, and new dead-letters.
  useNotifications({
    client: wireClient,
    prefs: notificationPrefs,
    workSources: enabledIds(connectorPrefs, "work"),
    serviceBusEnabled: enabledIds(connectorPrefs, "observability").includes("servicebus"),
    keyVaultEnabled: enabledIds(connectorPrefs, "observability").includes("keyvault"),
    keyVaultSubscriptions,
    chatSessionIds: ["session-1", SIDEBAR_SESSION_ID],
    isThreadActive,
    onNotifications: (items) => setNotifications((prev) => mergeFeed(prev, items))
  });

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

  const unread = unreadCount(notifications);

  // First launch (or after a reset): the provider-selection screen replaces the
  // cockpit until the user confirms which backends they have.
  if (!onboarded) {
    return (
      <>
        <MatrixRain />
        <Onboarding
          client={wireClient}
          catalog={catalog}
          detecting={detecting}
          initialEnabled={settings.backends}
          initialRoots={settings.workspaceRoots}
          initialPlans={plans}
          onComplete={completeOnboarding}
        />
      </>
    );
  }

  // On desktop the chat dock is THE chat surface, shown on every page (the Chat page
  // is a small-screen affordance, and the dock hides itself there via CSS). The shell
  // grid's third column follows the dock's expanded/collapsed state and dragged width.
  // The dock also hides on the Chat page itself so a phone never doubles the chat.
  const chatHidden = view === "run";
  const chatColumnClass = chatOpen ? "chat-open" : "chat-collapsed";
  const shellClass = chatHidden ? "app-shell" : `app-shell ${chatColumnClass}`;

  return (
    <div
      className={shellClass}
      style={{ "--chat-dock-w": `${chatWidth}px` } as CSSProperties}
    >
      <MatrixRain />
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

          {/* The Chat PAGE is the small-screen chat (the dock does not fit a phone);
              desktop reaches chat via the dock and never sees this tab in the nav. */}
          <div hidden={view !== "run"}>
            <RunScreen
              client={wireClient}
              workspaceRoots={settings.workspaceRoots}
              availableBackends={settings.backends}
              catalog={catalog}
              enabledModels={settings.enabledModels}
              plans={plans}
              {...(settings.defaultWorkspaceRoot === undefined
                ? {}
                : { defaultWorkspaceRoot: settings.defaultWorkspaceRoot })}
              onSetDefaultWorkspaceRoot={(root) =>
                setSettings((prev) => setDefaultWorkspaceRoot(prev, root))
              }
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

          <div hidden={view !== "groups"}>
            <GroupsView
              client={wireClient}
              active={view === "groups"}
              workspaceRoots={settings.workspaceRoots}
              runs={orderRuns(runs)}
            />
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

          <div hidden={view !== "repositories"}>
            <RepositoriesView
              client={wireClient}
              active={view === "repositories"}
              workspaceRoots={settings.workspaceRoots}
              {...(settings.defaultWorkspaceRoot === undefined
                ? {}
                : { defaultWorkspaceRoot: settings.defaultWorkspaceRoot })}
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

          <div hidden={view !== "updates"}>
            <UpdatesView client={wireClient} active={view === "updates"} catalog={catalog} />
          </div>

          <div hidden={view !== "notifications"}>
            <NotificationList
              notifications={notifications}
              active={view === "notifications"}
              onMarkAllRead={() =>
                setNotifications((prev) => prev.map((item) => ({ ...item, read: true })))
              }
              onClear={() => setNotifications([])}
            />
          </div>
        </div>
      </main>

      {/* The signature floating hive launcher: a collapsed hex that blooms into a honeycomb
          of view-tiles (one hex per visible nav view). Replaces the old left activity-bar;
          `position: fixed`, so its place in the tree is flexible. */}
      <HiveNav
        items={NAV_ITEMS}
        view={view}
        onSelect={setView}
        unread={unread}
        pagePrefs={pagePrefs}
        connected={connected}
        bridgeUrl={bridgeUrl}
        onBridgeUrl={setBridgeUrl}
        onConnect={onConnect}
        connectError={connectError}
      />

      {/* Right-hand chat dock: THE chat surface (history, model picker, attachments)
          on every page. Always mounted, so the conversation survives a collapse or a
          tab switch; drag its left edge to resize. */}
      <ChatSidebar
        hidden={chatHidden}
        open={chatOpen}
        onToggle={() => setChatOpen((prev) => !prev)}
        width={chatWidth}
        onResize={(width) => {
          setChatWidth(width);
          saveChatDockWidth(width);
        }}
        run={{
          client: wireClient,
          workspaceRoots: settings.workspaceRoots,
          availableBackends: settings.backends,
          catalog,
          enabledModels: settings.enabledModels,
          plans,
          ...(settings.defaultWorkspaceRoot === undefined
            ? {}
            : { defaultWorkspaceRoot: settings.defaultWorkspaceRoot }),
          onSetDefaultWorkspaceRoot: (root) =>
            setSettings((prev) => setDefaultWorkspaceRoot(prev, root)),
          onAddWorkspaceRoots: (paths) =>
            setSettings((prev) => {
              const next = [...prev.workspaceRoots];
              for (const path of paths) {
                if (!next.includes(path)) {
                  next.push(path);
                }
              }
              return { ...prev, workspaceRoots: next };
            }),
          onRunStarted: (init) => setRuns((prev) => registerRun(prev, init))
        }}
      />

      {/* Settings is a modal overlay (left section-nav + scrollable pane) rather than an inline
          page, so its distinct groups are easier to tell apart. Mounted only while open; closing
          returns to the Hub. */}
      {view === "settings" && (
        <SettingsModal
          settings={settings}
          onSettingsChange={setSettings}
          catalog={catalog}
          client={wireClient}
          plans={plans}
          onPlansChange={setPlans}
          theme={theme}
          onThemeChange={setTheme}
          notificationPrefs={notificationPrefs}
          onNotificationPrefsChange={setNotificationPrefs}
          pagePrefs={pagePrefs}
          onPagePrefsChange={setPagePrefs}
          onClose={() => setView("hub")}
        />
      )}
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

function IconGroups() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="8" height="6" rx="1.5" />
      <rect x="13" y="4" width="8" height="6" rx="1.5" />
      <rect x="8" y="14" width="8" height="6" rx="1.5" />
      <path d="M7 10v2h10v-2M12 12v2" strokeLinecap="round" strokeLinejoin="round" />
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
