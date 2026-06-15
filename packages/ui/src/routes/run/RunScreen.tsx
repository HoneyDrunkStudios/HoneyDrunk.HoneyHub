import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentBackend,
  AgentDefinition,
  BackendCapability,
  DispatchActivity,
  DispatchArtifact,
  DispatchMessage,
  DispatchRunState,
  DispatchSession,
  StartRunRequest,
  UsageSignal
} from "@honeydrunk/honeyhub-types";
import { UsageBadge } from "../../components/UsageBadge";
import { backendLabel } from "../../backends";
import { recommendBackend } from "../routing/router";
import { loadRoutingSnapshot } from "../routing/routingSnapshot";
import { SessionDiagnostics } from "./SessionDiagnostics";
import { WorkspacePicker } from "./WorkspacePicker";
import { getChat, loadChatSummaries, saveChat, type ChatRecord } from "../../chatHistory";
import {
  availableSlashCommands,
  filterSlashCommands,
  isSlashQuery,
  slashQuery,
  type SlashCommand
} from "./slashCommands";
import type { WireClient } from "../../wire/client";

// Before the user configures any backends, the picker offers only the proven-initial
// backend (Claude). Codex/Copilot are offered once the user adds them in Bridge
// settings, so an empty config never implies an unconfigured/uninstalled CLI is
// launchable. The full configurable set lives in `settingsModel.allBackends` (the
// Bridge settings UI), not duplicated here.
const INITIAL_BACKENDS: AgentBackend[] = ["claude.local"];

export interface RunScreenProps {
  client: WireClient;
  /** Allowlisted workspace roots (packet 05). When empty, a free-text root is
      accepted and the bridge enforces the allowlist on launch. */
  workspaceRoots?: string[];
  /** The user's allowlisted backends. When empty (not yet configured), only the
      proven-initial backend (Claude) is offered, so an unconfigured cockpit never
      implies an uninstalled CLI is launchable; when set, the picker and the router
      consider only these. The bridge still enforces its allowlist on launch. */
  availableBackends?: AgentBackend[];
  /** The detected backend catalog, used to populate the model picker per provider. */
  catalog?: BackendCapability[];
  /** Per-provider enabled model ids. A backend absent from the map = all its models
      enabled (the default). Both the manual model picker and the optimize-mode auto
      choice are restricted to these. */
  enabledModels?: Partial<Record<AgentBackend, string[]>>;
  /** Persist locations browsed from the composer's workspace picker (folder or the
      repos a `.code-workspace` resolves to). */
  onAddWorkspaceRoots?: (paths: string[]) => void;
  /** Report a launched run to the active-runs dashboard (task + backend + model). */
  onRunStarted?: (init: {
    runId: string;
    sessionId: string;
    backend: AgentBackend;
    task: string;
    model?: string;
    createdAt: string;
  }) => void;
}

/** Cost mode: let the router pick the lowest-cost backend, or pin an exact model. */
type CostMode = "optimize" | "manual";

/** Sentinel select value for the free-text "Custom model…" option. The CLIs accept
    any --model id (full ids, account/BYOK models), so this covers anything not listed. */
const CUSTOM_MODEL = "__custom__";

const TERMINAL = new Set<DispatchRunState>(["completed", "failed", "cancelled"]);

function isTerminal(state: DispatchRunState | undefined): boolean {
  return state !== undefined && TERMINAL.has(state);
}

export function RunScreen({
  client,
  workspaceRoots = [],
  availableBackends = [],
  catalog = [],
  enabledModels = {},
  onAddWorkspaceRoots,
  onRunStarted
}: Readonly<RunScreenProps>) {
  // Offer the user's configured backends; before they configure any, fall back to the
  // proven-initial backend only (the bridge still enforces its allowlist on launch).
  // Memoized so the offered set has a stable identity for the pin-clearing effect below.
  const routableBackends = useMemo(
    () => (availableBackends.length > 0 ? availableBackends : INITIAL_BACKENDS),
    [availableBackends]
  );
  const [task, setTask] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState(workspaceRoots[0] ?? "");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [runState, setRunState] = useState<DispatchRunState | undefined>(undefined);
  const [messages, setMessages] = useState<DispatchMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [artifacts, setArtifacts] = useState<DispatchArtifact[]>([]);
  const [activities, setActivities] = useState<DispatchActivity[]>([]);
  const [usage, setUsage] = useState<UsageSignal[]>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  // How the backend/model is chosen: "optimize" lets the router pick the lowest-cost
  // backend (default); "manual" pins an exact provider + model.
  const [costMode, setCostMode] = useState<CostMode>("optimize");
  // The user's explicit provider/model picks (manual mode only).
  const [providerPick, setProviderPick] = useState<AgentBackend | undefined>(undefined);
  const [modelPick, setModelPick] = useState<string | undefined>(undefined);
  // The free-text id when "Custom model…" is chosen.
  const [customModel, setCustomModel] = useState("");
  // The chosen reasoning effort (Codex only; from the selected model's levels).
  const [effortPick, setEffortPick] = useState<string | undefined>(undefined);
  // Slash-command menu state (composer affordance): the highlighted item and whether the
  // menu was dismissed for the current query (Escape).
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // The backend the active run actually launched on, frozen at launch so the active
  // run's diagnostics never drift if the task/config changes mid-session.
  const [runBackend, setRunBackend] = useState<AgentBackend | undefined>(undefined);
  // When the active run started, for the saved chat-history record.
  const [runStartedAt, setRunStartedAt] = useState("");
  // A past chat opened read-only from history (null while composing/running).
  const [openedChat, setOpenedChat] = useState<ChatRecord | undefined>(undefined);
  // The discovered agent catalog (for the composer's agent picker) and the user's
  // selected agent name. Claude runs under `--agent <name>`; Codex has no agent flag.
  const [agentCatalog, setAgentCatalog] = useState<AgentDefinition[]>([]);
  const [agentPick, setAgentPick] = useState<string | undefined>(undefined);
  // Durable, bridge-backed past sessions (synced history). Populated from the bridge's
  // LocalStore when available; clicking one reopens it read-only.
  const [syncedSessions, setSyncedSessions] = useState<DispatchSession[]>([]);

  // The routing snapshot, loaded once through the consumption seam (a fetch-shaped
  // loader; v1 returns the bundled JSON projection).
  const snapshot = useMemo(() => loadRoutingSnapshot(), []);
  // The router's suggestion for the current task (app-tier, ADR-0092 D3). Recomputed
  // as the task text changes; a pure function of the task + the snapshot.
  const recommendation = useMemo(
    () => recommendBackend({ task, availableBackends: routableBackends }, snapshot),
    [task, routableBackends, snapshot]
  );
  // The backend a run will launch on. In optimize mode it is the router's live
  // suggestion; in manual mode the user's pick (ignored — falling back to the
  // suggestion — if it is no longer an offered backend). Derived, not synced via an
  // effect, so it is never stale at launch and the controls reflect it synchronously.
  const provider: AgentBackend =
    costMode === "manual" &&
    providerPick !== undefined &&
    routableBackends.includes(providerPick)
      ? providerPick
      : recommendation.backend;

  // The provider's full model list (from detection) and the subset the user enabled
  // in Bridge settings. An absent map entry means all models are enabled (default).
  const allModelsForProvider = useMemo(
    () => catalog.find((entry) => entry.backend === provider)?.models ?? [],
    [catalog, provider]
  );
  const modelsForProvider = useMemo(() => {
    const enabled = enabledModels[provider];
    if (enabled === undefined) {
      return allModelsForProvider;
    }
    return allModelsForProvider.filter((model) => enabled.includes(model.id));
  }, [allModelsForProvider, enabledModels, provider]);
  // True when the user has narrowed this provider's models — so even the auto path
  // must pin an enabled model rather than fall through to the CLI default.
  const modelsRestricted =
    allModelsForProvider.length > 0 &&
    modelsForProvider.length < allModelsForProvider.length;

  // Whether the user chose the free-text "Custom model…" option.
  const isCustomModel = costMode === "manual" && modelPick === CUSTOM_MODEL;

  // The model a run will launch with. Manual mode uses the user's pick (custom text,
  // or the selected id, defaulting to the first enabled model); optimize mode leaves
  // it to the CLI default unless the user narrowed the model set, in which case it
  // picks the first enabled model so the auto choice never lands on a disabled one.
  const model: string | undefined =
    costMode === "manual"
      ? isCustomModel
        ? customModel.trim() || undefined
        : modelPick ?? modelsForProvider[0]?.id
      : modelsRestricted
        ? modelsForProvider[0]?.id
        : undefined;

  // Reasoning-effort levels for the resolved model (Codex exposes these; Claude has no
  // effort flag). Only offered when a concrete model with levels is selected.
  const selectedModel = useMemo(
    () => allModelsForProvider.find((entry) => entry.id === model),
    [allModelsForProvider, model]
  );
  const effortLevels = useMemo(() => selectedModel?.reasoningLevels ?? [], [selectedModel]);
  const effortSupported = provider === "codex.local" && effortLevels.length > 0;
  // The effort a run will launch with (only when supported and the pick is valid).
  const effort: string | undefined =
    effortSupported && effortPick !== undefined && effortLevels.includes(effortPick)
      ? effortPick
      : undefined;

  // Drop an effort pick that no longer applies (provider/model changed away from one
  // that offers it), so a stale level is never sent at launch.
  useEffect(() => {
    if (effortPick !== undefined && !effortLevels.includes(effortPick)) {
      setEffortPick(undefined);
    }
  }, [effortPick, effortLevels]);

  // Drop a provider pick that has fallen out of the offered set (the user changed
  // their configured backends), so it neither launches nor silently resurrects if the
  // backend is later re-added — the choice returns to the live suggestion.
  useEffect(() => {
    if (providerPick !== undefined && !routableBackends.includes(providerPick)) {
      setProviderPick(undefined);
    }
  }, [providerPick, routableBackends]);

  // Drop a model pick that no longer belongs to the offered set (provider changed, or
  // the model was disabled in settings), so a stale id is never sent at launch. The
  // "Custom model…" sentinel is exempt — it is intentionally not in the listed set.
  useEffect(() => {
    if (
      modelPick !== undefined &&
      modelPick !== CUSTOM_MODEL &&
      !modelsForProvider.some((m) => m.id === modelPick)
    ) {
      setModelPick(undefined);
    }
  }, [modelPick, modelsForProvider]);

  // Discover the agent catalog once for the composer's agent picker. A dedicated
  // subscription (the main one filters to the active run, but the catalog is a
  // device-wide event), plus a one-shot discover on mount.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "agent_catalog") {
        setAgentCatalog(event.payload.agents);
      }
    });
    void client.discoverAgents().catch(() => undefined);
    return unsubscribe;
  }, [client]);

  // Durable synced history: list bridge-backed sessions on mount, and when one's detail
  // arrives (after a click) reopen it read-only by building a ChatRecord from it.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "session_list") {
        setSyncedSessions(event.payload.sessions);
      } else if (event.payload.kind === "session_detail") {
        const { sessionId, runs: detailRuns, transcript } = event.payload;
        setSyncedSessions((sessions) => {
          const meta = sessions.find((session) => session.id === sessionId);
          const lastState = detailRuns.at(-1)?.state ?? "completed";
          setOpenedChat({
            id: sessionId,
            task: meta?.title ?? transcript[0]?.body ?? "(session)",
            ...(meta?.backend !== undefined ? { backend: meta.backend } : {}),
            state: lastState,
            messages: transcript,
            totalUsd: 0,
            totalTokens: 0,
            createdAt: meta?.createdAt ?? "",
            updatedAt: meta?.updatedAt ?? ""
          });
          return sessions;
        });
      }
    });
    void client.listSessions().catch(() => undefined);
    return unsubscribe;
  }, [client]);

  // Agents runnable on the selected provider (Claude `--agent`; Codex has no agent
  // flag, so the picker is empty/disabled for it). One entry per name.
  const agentsForProvider = useMemo(
    () =>
      agentCatalog.filter((agent) =>
        agent.backends.some((binding) => binding.backend === provider)
      ),
    [agentCatalog, provider]
  );
  const agentPickingSupported = provider === "claude.local";

  // Drop an agent pick that is no longer available on the selected provider.
  useEffect(() => {
    if (
      agentPick !== undefined &&
      !agentsForProvider.some((agent) => agent.name === agentPick)
    ) {
      setAgentPick(undefined);
    }
  }, [agentPick, agentsForProvider]);

  // The provider-aware slash-command list, filtered by what the user has typed after `/`.
  const slashCommands = useMemo(() => {
    if (!isSlashQuery(task)) {
      return [];
    }
    const all = availableSlashCommands({
      provider,
      costMode,
      agents: agentPickingSupported ? agentsForProvider.map((agent) => agent.name) : [],
      effortLevels
    });
    return filterSlashCommands(all, slashQuery(task));
  }, [task, provider, costMode, agentPickingSupported, agentsForProvider, effortLevels]);
  const slashOpen = slashCommands.length > 0 && !slashDismissed;

  // Keep the highlighted index in range as the filtered list changes.
  useEffect(() => {
    setSlashIndex((index) => (index >= slashCommands.length ? 0 : index));
  }, [slashCommands.length]);

  // Apply a chosen slash command, then clear the `/…` token from the composer.
  const runSlashCommand = (command: SlashCommand) => {
    setTask("");
    setSlashDismissed(false);
    setSlashIndex(0);
    if (command.id === "new") {
      setMessages([]);
      setArtifacts([]);
      setActivities([]);
      setUsage([]);
      setOpenedChat(undefined);
      setRunId(undefined);
      setError(undefined);
    } else if (command.id === "clear") {
      // Already cleared above.
    } else if (command.id === "optimize") {
      setCostMode("optimize");
    } else if (command.id === "model") {
      setCostMode("manual");
    } else if (command.id.startsWith("effort:")) {
      setCostMode("manual");
      setEffortPick(command.id.slice("effort:".length));
    } else if (command.id.startsWith("agent:")) {
      setAgentPick(command.id.slice("agent:".length));
    }
  };

  // Keep the active run id available to the event handler without re-subscribing.
  const runIdRef = useRef<string | undefined>(undefined);
  runIdRef.current = runId;

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (runIdRef.current !== undefined && event.runId !== runIdRef.current) {
        return;
      }
      const payload = event.payload;
      switch (payload.kind) {
        case "message":
          if (payload.message.isPartial === true) {
            setStreaming((prev) => prev + payload.message.body);
          } else {
            setStreaming("");
            setMessages((prev) => [...prev, payload.message]);
          }
          break;
        case "status":
          setRunState(payload.status.state);
          break;
        case "usage":
          setUsage((prev) => [...prev, payload.signal]);
          break;
        case "artifact":
          setArtifacts((prev) => [...prev, payload.artifact]);
          break;
        case "activity":
          setActivities((prev) => [...prev, payload.activity]);
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [client]);

  const active = runId !== undefined && !isTerminal(runState);

  const userMessage = (id: string, forRunId: string, body: string): DispatchMessage => ({
    id,
    sessionId: "session-1",
    runId: forRunId,
    role: "user",
    body,
    createdAt: new Date().toISOString()
  });

  // Begin a run under a client-preallocated id. Binding `runIdRef` (and the
  // request's `requestedRunId`) before `start` means the event handler filters to
  // this run from the first event, rather than briefly accepting all events.
  const beginRun = async (
    taskText: string,
    options?: { followUpToRunId?: string; transcript?: DispatchMessage[] }
  ): Promise<string> => {
    const newRunId = crypto.randomUUID();
    runIdRef.current = newRunId;
    setRunId(newRunId);
    setRunState(undefined);
    setStreaming("");
    // Freeze the backend + model for this run so the request and the active-run
    // diagnostics use exactly what launched, even if the task/config changes
    // mid-session.
    const launchBackend = provider;
    const launchModel = model;
    // Only Claude honors `--agent`; never send an agent for a backend that ignores it.
    const launchAgent =
      launchBackend === "claude.local" && agentPick !== undefined ? agentPick : undefined;
    // Only Codex honors a reasoning-effort override.
    const launchEffort = launchBackend === "codex.local" ? effort : undefined;
    const startedAt = new Date().toISOString();
    setRunBackend(launchBackend);
    setRunStartedAt(startedAt);
    onRunStarted?.({
      runId: newRunId,
      sessionId: "session-1",
      backend: launchBackend,
      task: taskText,
      ...(launchModel !== undefined ? { model: launchModel } : {}),
      createdAt: startedAt
    });

    const request: StartRunRequest = {
      session: {
        id: "session-1",
        backend: launchBackend,
        title: taskText,
        workspaceRoot,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      workspaceRoot,
      task: taskText,
      requestedRunId: newRunId
    };
    // Pin the model only when one is resolved (manual pick, or an enabled model in
    // optimize mode); otherwise the adapter uses its default (exactOptionalPropertyTypes).
    if (launchModel !== undefined) {
      request.model = launchModel;
    }
    if (launchAgent !== undefined) {
      request.agent = launchAgent;
    }
    if (launchEffort !== undefined) {
      request.effort = launchEffort;
    }
    // Set the optional follow-up fields only when present (exactOptionalPropertyTypes).
    if (options?.followUpToRunId !== undefined) {
      request.followUpToRunId = options.followUpToRunId;
    }
    if (options?.transcript !== undefined) {
      request.transcript = options.transcript;
    }
    await client.start(request);
    return newRunId;
  };

  const onStart = async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setError("Enter a task to start a run.");
      return;
    }
    // A workspace is optional — with none picked, the bridge runs a "just chat" session
    // in the user's home dir.
    setError(undefined);
    setArtifacts([]);
    setActivities([]);
    setUsage([]);
    try {
      const newRunId = await beginRun(trimmed);
      setMessages([userMessage("user-0", newRunId, trimmed)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to start run");
    }
  };

  const onSend = async () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || runId === undefined) {
      return;
    }
    setReply("");
    try {
      if (needsInput) {
        // Live, same-process reply into the active run.
        setMessages((prev) => [...prev, userMessage(`user-${prev.length}`, runId, trimmed)]);
        await client.reply(runId, trimmed);
      } else if (canFollowUp) {
        // A follow-up after completion is a NEW run carrying the prior transcript
        // (ADR-0090 D4 / StartRunRequest.followUpToRunId), not a reply into the
        // completed run.
        const priorTranscript = messages;
        const previousRunId = runId;
        const newRunId = await beginRun(trimmed, {
          followUpToRunId: previousRunId,
          transcript: priorTranscript
        });
        setMessages((prev) => [...prev, userMessage(`user-${prev.length}`, newRunId, trimmed)]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to send");
    }
  };

  const onStop = async () => {
    if (runId === undefined) {
      return;
    }
    try {
      await client.stop(runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to stop");
    }
  };

  const latestUsage = useMemo(() => usage.at(-1), [usage]);
  const needsInput = runState === "needs_input";
  const canFollowUp = isTerminal(runState);

  // Persist the active chat to local history as it progresses, so it can be reopened.
  useEffect(() => {
    if (runId === undefined || messages.length === 0) {
      return;
    }
    const usedModel = latestUsage?.modelLabel ?? model;
    saveChat({
      id: runId,
      task,
      ...(runBackend !== undefined ? { backend: runBackend } : {}),
      ...(usedModel !== undefined ? { model: usedModel } : {}),
      state: runState ?? "running",
      messages,
      totalUsd: usage.reduce((sum, signal) => sum + (signal.totalUsd ?? 0), 0),
      totalTokens: usage.reduce((sum, signal) => sum + (signal.totalTokens ?? 0), 0),
      createdAt: runStartedAt.length > 0 ? runStartedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }, [runId, messages, usage, runState, task, runBackend, model, latestUsage, runStartedAt]);

  // The model/cost controls shared by the composer (compact toolbar form).
  const modelControls = (
    <>
      <div className="cost-mode" role="group" aria-label="Model selection mode">
        <button
          type="button"
          className="seg"
          aria-pressed={costMode === "optimize"}
          onClick={() => setCostMode("optimize")}
        >
          Optimize cost
        </button>
        <button
          type="button"
          className="seg"
          aria-pressed={costMode === "manual"}
          onClick={() => setCostMode("manual")}
        >
          Pick model
        </button>
      </div>
      {agentPickingSupported && agentsForProvider.length > 0 && (
        <select
          className="chip-select"
          aria-label="Agent"
          value={agentPick ?? ""}
          onChange={(event) =>
            setAgentPick(event.target.value === "" ? undefined : event.target.value)
          }
        >
          <option value="">No agent</option>
          {agentsForProvider.map((agent) => (
            <option key={agent.id} value={agent.name}>
              {agent.name}
            </option>
          ))}
        </select>
      )}
      {effortSupported && (
        <select
          className="chip-select"
          aria-label="Reasoning effort"
          value={effortPick ?? ""}
          onChange={(event) =>
            setEffortPick(event.target.value === "" ? undefined : event.target.value)
          }
        >
          <option value="">Default effort</option>
          {effortLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      {costMode === "manual" && (
        <>
          <select
            className="chip-select"
            aria-label="Provider"
            value={provider}
            onChange={(event) => {
              setProviderPick(event.target.value as AgentBackend);
              setModelPick(undefined);
            }}
          >
            {routableBackends.map((option) => (
              <option key={option} value={option}>
                {backendLabel(option)}
                {option === recommendation.backend ? " (suggested)" : ""}
              </option>
            ))}
          </select>
          <select
            className="chip-select"
            aria-label="Model"
            value={modelPick ?? modelsForProvider[0]?.id ?? CUSTOM_MODEL}
            onChange={(event) => setModelPick(event.target.value)}
          >
            {modelsForProvider.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Custom model…</option>
          </select>
          {isCustomModel && (
            <input
              className="chip-input"
              aria-label="Custom model id"
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder="exact model id (e.g. gpt-5.5-codex)"
            />
          )}
        </>
      )}
    </>
  );

  return (
    <section className="chat" aria-label="Run">
      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}

      {openedChat !== undefined ? (
        <div className="chat-history-view">
          <header className="chat-head">
            <h2 className="chat-title">{openedChat.task}</h2>
            <button
              type="button"
              className="onboarding-back"
              onClick={() => setOpenedChat(undefined)}
            >
              New chat
            </button>
          </header>
          <p className="routing-rationale">
            {openedChat.backend !== undefined ? backendLabel(openedChat.backend) : "—"}
            {openedChat.model !== undefined ? ` · ${openedChat.model}` : ""}
            {` · $${openedChat.totalUsd.toFixed(4)} · ${openedChat.state}`}
          </p>
          <ol className="transcript" aria-label="Transcript">
            {openedChat.messages.map((message) => (
              <li key={message.id} className={`message role-${message.role}`}>
                <span className="message-role">{message.role}</span>
                <span className="message-body">{message.body}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : runId === undefined ? (
        <div className="chat-start">
          <h2 className="chat-heading">What should we work on?</h2>
          <div className="composer">
            {slashOpen && (
              <SlashMenu
                commands={slashCommands}
                activeIndex={slashIndex}
                onSelect={runSlashCommand}
                onHover={setSlashIndex}
              />
            )}
            <textarea
              className="composer-input"
              aria-label="Task"
              value={task}
              onChange={(event) => {
                setSlashDismissed(false);
                setTask(event.target.value);
              }}
              onKeyDown={(event) => {
                // Slash menu open: arrows move, Enter selects, Escape dismisses.
                if (slashOpen) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashIndex((index) => (index + 1) % slashCommands.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashIndex(
                      (index) => (index - 1 + slashCommands.length) % slashCommands.length
                    );
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    const chosen = slashCommands[slashIndex];
                    if (chosen !== undefined) {
                      runSlashCommand(chosen);
                    }
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                // Enter sends; Shift+Enter inserts a newline.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onStart();
                }
              }}
              placeholder="Do anything"
              rows={3}
            />
            <div className="composer-bar">
              <div className="composer-controls">
                <WorkspacePicker
                  client={client}
                  roots={workspaceRoots}
                  value={workspaceRoot}
                  onSelect={setWorkspaceRoot}
                  onAddRoots={onAddWorkspaceRoots ?? (() => undefined)}
                />
                {modelControls}
              </div>
              <button
                type="button"
                className="composer-send"
                aria-label="Start session"
                onClick={onStart}
              >
                ↑
              </button>
            </div>
          </div>
          <p className="routing-rationale">
            {costMode === "optimize" ? (
              <>
                {recommendation.rationale}
                {recommendation.snapshotSource === "bundled-default" && (
                  <span className="routing-source"> · rates: bundled</span>
                )}
              </>
            ) : (
              <>Launching {backendLabel(provider)}{model !== undefined ? ` · ${model}` : ""}.</>
            )}
          </p>

          {(() => {
            const recents = loadChatSummaries().slice(0, 8);
            return recents.length === 0 ? null : (
              <div className="recent-chats">
                <p className="eyebrow">Recent chats</p>
                <ul aria-label="Recent chats">
                  {recents.map((chat) => (
                    <li key={chat.id}>
                      <button
                        type="button"
                        className="recent-chat"
                        onClick={() => setOpenedChat(getChat(chat.id))}
                      >
                        <span className="recent-task">{chat.task}</span>
                        <span className="recent-meta">
                          {chat.backend !== undefined ? backendLabel(chat.backend) : "—"}
                          {chat.model !== undefined ? ` · ${chat.model}` : ""}
                          {` · $${chat.totalUsd.toFixed(4)}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {syncedSessions.length > 0 && (
            <div className="recent-chats synced-history">
              <p className="eyebrow">Synced history</p>
              <ul aria-label="Synced history">
                {syncedSessions.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="recent-chat"
                      onClick={() => void client.sessionDetail(session.id).catch(() => undefined)}
                    >
                      <span className="recent-task">{session.title}</span>
                      <span className="recent-meta">{backendLabel(session.backend)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="chat-active">
          <div className="chat-main">
            <header className="chat-head">
              <h2 className="chat-title">{task}</h2>
              {runState !== undefined && (
                <span className="status-pill" aria-label="Run state">
                  {runState}
                </span>
              )}
            </header>

            <ol className="transcript" aria-label="Transcript">
              {messages.map((message) => (
                <li key={message.id} className={`message role-${message.role}`}>
                  <span className="message-role">{message.role}</span>
                  <span className="message-body">{message.body}</span>
                </li>
              ))}
              {streaming.length > 0 && (
                <li className="message role-agent streaming" aria-label="Streaming">
                  <span className="message-role">agent</span>
                  <span className="message-body">{streaming}</span>
                </li>
              )}
            </ol>

            <div className="run-controls">
              {(needsInput || canFollowUp) && (
                <div className="reply-box">
                  <label htmlFor="reply">{needsInput ? "Reply" : "Follow up"}</label>
                  <input
                    id="reply"
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void onSend();
                      }
                    }}
                  />
                  <button type="button" onClick={onSend}>
                    Send
                  </button>
                </div>
              )}
              {active && (
                <button type="button" className="stop" onClick={onStop}>
                  Stop
                </button>
              )}
            </div>
          </div>

          <aside className="chat-details" aria-label="Run details">
            <p className="eyebrow">Details</p>
            <SessionDiagnostics backend={runBackend ?? provider} messages={messages} usage={usage} />
            {latestUsage !== undefined && (
              <div className="detail-usage">
                <span className="detail-label">Latest usage</span>
                <UsageBadge usage={latestUsage} />
              </div>
            )}
            {activities.length > 0 && (
              <div className="activity">
                <p className="detail-label">Activity</p>
                <ul className="activity-list" aria-label="Activity">
                  {activities.map((item) => (
                    <li key={item.id} className={`activity-item kind-${item.kind}`}>
                      <span className="activity-label">{item.label}</span>
                      {item.detail !== undefined && (
                        <span className="activity-detail">{item.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {artifacts.length > 0 && (
              <ul className="artifacts" aria-label="Artifacts">
                {artifacts.map((artifact) => (
                  <li key={artifact.id} className={`artifact kind-${artifact.kind}`}>
                    <span className="artifact-kind">{artifact.kind}</span>
                    {artifact.href === undefined ? (
                      <span>{artifact.label}</span>
                    ) : (
                      <a href={artifact.href} target="_blank" rel="noopener noreferrer">
                        {artifact.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

interface SlashMenuProps {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/** The slash-command popover shown above the composer when the input starts with `/`.
    Keyboard nav lives on the textarea (arrows/Enter/Escape); this renders + handles clicks. */
function SlashMenu({ commands, activeIndex, onSelect, onHover }: Readonly<SlashMenuProps>) {
  return (
    <ul className="slash-menu" aria-label="Slash commands">
      {commands.map((command, index) => (
        <li key={command.id}>
          <button
            type="button"
            className={`slash-item ${index === activeIndex ? "is-active" : ""}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(command)}
          >
            <span className="slash-label">{command.label}</span>
            <span className="slash-hint">{command.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
