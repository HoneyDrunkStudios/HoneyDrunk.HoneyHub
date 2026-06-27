import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement
} from "react";
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
import { resolveDefaultWorkspaceRoot } from "../../settingsModel";
import type { Plans } from "../../plans";
import { recommendBackend } from "../routing/router";
import { loadRoutingSnapshot } from "../routing/routingSnapshot";
import { SessionDiagnostics } from "./SessionDiagnostics";
import { WorkspacePicker } from "./WorkspacePicker";
import { ModelMenu, type ModelOption } from "./ModelMenu";
import { getChat, loadChatSummaries, saveChat, type ChatRecord } from "../../chatHistory";
import {
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  readFileAsAttachment,
  toChatAttachments,
  type PendingAttachment
} from "../chat/attachments";
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
  /** The user's subscription plans. Used only to enrich the router's recommendation:
      a flat-rate plan makes that backend effectively free in cost-optimize mode. */
  plans?: Plans;
  /** Layout variant. `full` is the dedicated Chat page (transcript + a details aside);
      `sidebar` is the compact docked panel (single column, no aside) that the
      ChatSidebar renders. Both share all the chat logic — only the chrome differs. */
  variant?: "full" | "sidebar";
  /** The session id this surface runs under. Defaults to the original single-session id.
      The sidebar passes its own so its runs do not collide with the full Chat page's. */
  sessionId?: string;
  /** The user's default workspace, pre-selected in the composer's workspace picker.
      Falls back to the first root when unset or no longer configured. */
  defaultWorkspaceRoot?: string;
  /** Set the default workspace (the picker's star). Omitted = no default affordance. */
  onSetDefaultWorkspaceRoot?: (root: string) => void;
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
    workspaceRoot?: string;
    createdAt: string;
  }) => void;
}

/** Cost mode: let the router pick the lowest-cost backend, or pin an exact model. */
type CostMode = "optimize" | "manual";

/** Sentinel select value for the free-text "Custom model…" option. The CLIs accept
    any --model id (full ids, account/BYOK models), so this covers anything not listed. */
const CUSTOM_MODEL = "__custom__";

// Composer prompts: cyberpunk and Matrix flavor. One is picked at random when the run
// screen mounts, stable while you're on it; it does not change on every click.
export const COMPOSER_PROMPTS = [
  "What are we building tonight?",
  "Jack in. Name the job.",
  "Point me at the problem.",
  "What system are we bending today?",
  "Spin up something dangerous.",
  "What's the directive, operator?",
  "Let's carve order out of the noise.",
  "Wire me into the work.",
  "What are we shipping?",
  "Give me a target.",
  "Wake up, operator…",
  "Follow the white rabbit.",
  "There is no spoon.",
  "The Grid has you.",
  "Knock, knock.",
  "Free your mind.",
  "I know kung fu.",
  "We've been expecting you, Mr. Anderson.",
];

const TERMINAL = new Set<DispatchRunState>(["completed", "failed", "cancelled"]);

function isTerminal(state: DispatchRunState | undefined): boolean {
  return state !== undefined && TERMINAL.has(state);
}

/** Append a short note naming the attached files to the displayed user turn, so the
    transcript honestly reflects what was sent (the bridge injects the real paths). */
function withAttachmentNote(text: string, attachments: PendingAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }
  const names = attachments.map((item) => item.name).join(", ");
  return `${text}\n\n[Attached: ${names}]`;
}

export function RunScreen({
  client,
  workspaceRoots = [],
  availableBackends = [],
  catalog = [],
  enabledModels = {},
  plans = {},
  variant = "full",
  sessionId = "session-1",
  defaultWorkspaceRoot,
  onSetDefaultWorkspaceRoot,
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
  // A varied prompt per mount (time-seeded), intentionally not reactive to clicks.
  const [promptIndex] = useState(() => Date.now() % COMPOSER_PROMPTS.length);
  const [workspaceRoot, setWorkspaceRoot] = useState(() =>
    resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot)
  );
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
  // Files staged in the composer (picked, pasted, or dropped) to send with the next turn.
  // The bridge writes them to a temp dir and references their paths in the task.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The routing snapshot, loaded once through the consumption seam (a fetch-shaped
  // loader; v1 returns the bundled JSON projection).
  const snapshot = useMemo(() => loadRoutingSnapshot(), []);
  // The router's suggestion for the current task (app-tier, ADR-0092 D3). Recomputed
  // as the task text changes; a pure function of the task + the snapshot.
  const recommendation = useMemo(
    () => recommendBackend({ task, availableBackends: routableBackends, plans }, snapshot),
    [task, routableBackends, snapshot, plans]
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

  // One flat, cross-backend model list for the unified picker — each entry carries its
  // backend so selecting a model routes to the right provider (no separate provider
  // picker). Honors the user's per-backend enabled-model narrowing.
  const unifiedModels = useMemo<ModelOption[]>(() => {
    const out: ModelOption[] = [];
    for (const backend of routableBackends) {
      const all = catalog.find((entry) => entry.backend === backend)?.models ?? [];
      const enabled = enabledModels[backend];
      const models = enabled === undefined ? all : all.filter((m) => enabled.includes(m.id));
      for (const model of models) {
        out.push({ backend, id: model.id, label: model.label });
      }
    }
    return out;
  }, [routableBackends, catalog, enabledModels]);
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
  const manualModel: string | undefined = isCustomModel
    ? customModel.trim() || undefined
    : modelPick ?? modelsForProvider[0]?.id;
  const autoModel: string | undefined = modelsRestricted
    ? modelsForProvider[0]?.id
    : undefined;
  const model: string | undefined = costMode === "manual" ? manualModel : autoModel;

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

  // Reopen a synced session read-only by building a ChatRecord from its detail. Reads the
  // latest session list (for the session's metadata) without mutating it, then opens the
  // chat. Extracted from the subscription handler to avoid a deeply nested callback.
  const reopenSyncedSession = (detail: {
    sessionId: string;
    runs: { state: DispatchRunState }[];
    transcript: DispatchMessage[];
  }) => {
    setSyncedSessions((sessions) => {
      const meta = sessions.find((session) => session.id === detail.sessionId);
      const lastState = detail.runs.at(-1)?.state ?? "completed";
      setOpenedChat({
        id: detail.sessionId,
        task: meta?.title ?? detail.transcript[0]?.body ?? "(session)",
        ...(meta?.backend === undefined ? {} : { backend: meta.backend }),
        state: lastState,
        messages: detail.transcript,
        totalUsd: 0,
        totalTokens: 0,
        createdAt: meta?.createdAt ?? "",
        updatedAt: meta?.updatedAt ?? ""
      });
      return sessions;
    });
  };

  // Durable synced history: list bridge-backed sessions on mount, and when one's detail
  // arrives (after a click) reopen it read-only by building a ChatRecord from it.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "session_list") {
        setSyncedSessions(event.payload.sessions);
      } else if (event.payload.kind === "session_detail") {
        const { sessionId, runs: detailRuns, transcript } = event.payload;
        reopenSyncedSession({ sessionId, runs: detailRuns, transcript });
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
    sessionId,
    runId: forRunId,
    role: "user",
    body,
    createdAt: new Date().toISOString()
  });

  // Stage files for the next turn (from the picker, a paste, or a drop). Oversized files
  // are rejected with an inline note; the rest are read to base64 and added as chips.
  const addFiles = async (files: FileList | File[] | null | undefined): Promise<void> => {
    if (files === null || files === undefined) {
      return;
    }
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    setAttachError(undefined);
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachError(
          `${file.name.length > 0 ? file.name : "That file"} is too large (max ${formatBytes(
            MAX_ATTACHMENT_BYTES
          )}).`
        );
        continue;
      }
      try {
        const attachment = await readFileAsAttachment(file);
        setAttachments((prev) => [...prev, attachment]);
      } catch {
        setAttachError("Could not read that file.");
      }
    }
  };

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  // Pasting an image (or any file) into the composer stages it, matching how the major
  // chat clients accept a screenshot from the clipboard.
  const onComposerPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const files = event.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      void addFiles(files);
    }
  };

  // Dropping files onto the composer stages them too.
  const onComposerDrop = (event: DragEvent<HTMLElement>): void => {
    const files = event.dataTransfer?.files;
    if (files !== undefined && files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  // Begin a run under a client-preallocated id. Binding `runIdRef` (and the
  // request's `requestedRunId`) before `start` means the event handler filters to
  // this run from the first event, rather than briefly accepting all events.
  const beginRun = async (
    taskText: string,
    options?: {
      followUpToRunId?: string;
      transcript?: DispatchMessage[];
      attachments?: PendingAttachment[];
    }
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
      sessionId,
      backend: launchBackend,
      task: taskText,
      ...(launchModel === undefined ? {} : { model: launchModel }),
      ...(workspaceRoot.length === 0 ? {} : { workspaceRoot }),
      createdAt: startedAt
    });

    const request: StartRunRequest = {
      session: {
        id: sessionId,
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
    if (options?.attachments !== undefined && options.attachments.length > 0) {
      request.attachments = toChatAttachments(options.attachments);
    }
    await client.start(request);
    return newRunId;
  };

  const onStart = async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0 && attachments.length === 0) {
      setError("Enter a task or attach a file to start a run.");
      return;
    }
    // An attachment-only turn still needs a prompt for the agent; supply a neutral one.
    const taskText = trimmed.length > 0 ? trimmed : "Take a look at the attached file(s).";
    const sent = attachments;
    // A workspace is optional — with none picked, the bridge runs a "just chat" session
    // in the user's home dir.
    setError(undefined);
    setArtifacts([]);
    setActivities([]);
    setUsage([]);
    try {
      const newRunId = await beginRun(taskText, sent.length > 0 ? { attachments: sent } : undefined);
      setMessages([userMessage("user-0", newRunId, withAttachmentNote(taskText, sent))]);
      setAttachments([]);
      setAttachError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "failed to start run");
    }
  };

  const onSend = async () => {
    if (runId === undefined) {
      return;
    }
    const trimmed = reply.trim();
    try {
      if (needsInput) {
        // Live, same-process reply into the active run (text only; attachments belong to a
        // new run, not a live in-process reply).
        if (trimmed.length === 0) {
          return;
        }
        setReply("");
        setMessages((prev) => [...prev, userMessage(`user-${prev.length}`, runId, trimmed)]);
        await client.reply(runId, trimmed);
      } else if (canFollowUp) {
        // A follow-up after completion is a NEW run carrying the prior transcript
        // (ADR-0090 D4 / StartRunRequest.followUpToRunId), not a reply into the
        // completed run. It can carry its own attachments.
        if (trimmed.length === 0 && attachments.length === 0) {
          return;
        }
        const taskText = trimmed.length > 0 ? trimmed : "Take a look at the attached file(s).";
        const sent = attachments;
        setReply("");
        const priorTranscript = messages;
        const previousRunId = runId;
        const newRunId = await beginRun(taskText, {
          followUpToRunId: previousRunId,
          transcript: priorTranscript,
          ...(sent.length > 0 ? { attachments: sent } : {})
        });
        setMessages((prev) => [
          ...prev,
          userMessage(`user-${prev.length}`, newRunId, withAttachmentNote(taskText, sent))
        ]);
        setAttachments([]);
        setAttachError(undefined);
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

  // Request a synced session's detail; the subscription reopens it read-only when it
  // arrives. Bound to `client` here so the SyncedHistory list stays a flat presentational
  // component with no nested callbacks.
  const openSyncedSession = (id: string): void => {
    void client.sessionDetail(id).catch(() => undefined);
  };

  // Composer keyboard handling, extracted from the textarea so the main render stays
  // flat. Slash menu open: arrows move, Enter selects, Escape dismisses; otherwise Enter
  // sends and Shift+Enter inserts a newline.
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slashCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => (index - 1 + slashCommands.length) % slashCommands.length);
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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onStart();
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
      ...(runBackend === undefined ? {} : { backend: runBackend }),
      ...(usedModel === undefined ? {} : { model: usedModel }),
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
      <div className="cost-mode" aria-label="Model selection mode">
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
          <ModelMenu
            options={unifiedModels}
            selectedBackend={provider}
            selectedId={modelPick ?? modelsForProvider[0]?.id ?? CUSTOM_MODEL}
            customId={CUSTOM_MODEL}
            suggestedBackend={recommendation.backend}
            onSelect={(backend, id) => {
              setProviderPick(backend);
              setModelPick(id);
            }}
          />
          {isCustomModel && routableBackends.length > 1 && (
            <div className="cost-mode" aria-label="Custom model backend">
              {routableBackends.map((option) => (
                <button
                  type="button"
                  key={option}
                  className="seg"
                  aria-pressed={provider === option}
                  onClick={() => setProviderPick(option)}
                >
                  {backendLabel(option)}
                </button>
              ))}
            </div>
          )}
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

  // The "attach a file" control: a paperclip button that opens the OS file picker. The
  // staged files render as chips (below the composer) via `attachmentChips`. Paste + drop
  // are wired on the input surfaces themselves.
  const attachButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Attach files"
        onChange={(event) => {
          void addFiles(event.target.files);
          // Reset so re-picking the same file fires another change.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="chip-button attach-button"
        aria-label="Attach files"
        title="Attach files or paste an image"
        onClick={() => fileInputRef.current?.click()}
      >
        <IconPaperclip />
      </button>
    </>
  );

  // The staged-attachment chips + any read error. Shown above the send row in the composer
  // and the follow-up box so the user can see and remove what they are about to send.
  const attachmentChips =
    attachments.length === 0 && attachError === undefined ? null : (
      <div className="attachment-tray">
        {attachments.length > 0 && (
          <ul className="attachment-list" aria-label="Attachments">
            {attachments.map((item) => (
              <li key={item.id} className="attachment-chip">
                <span className="attachment-name" title={item.name}>
                  {item.name}
                </span>
                <span className="attachment-size">{formatBytes(item.size)}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeAttachment(item.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachError !== undefined && (
          <p role="alert" className="attachment-error">
            {attachError}
          </p>
        )}
      </div>
    );

  const renderHistory = (chat: ChatRecord) => (
    <div className="chat-history-view">
          <header className="chat-head">
            <h2 className="chat-title">{chat.task}</h2>
            <button
              type="button"
              className="onboarding-back"
              onClick={() => setOpenedChat(undefined)}
            >
              New chat
            </button>
          </header>
          <p className="routing-rationale">
            {chat.backend === undefined ? "-" : backendLabel(chat.backend)}
            {chat.model === undefined ? "" : ` · ${chat.model}`}
            {` · $${chat.totalUsd.toFixed(4)} · ${chat.state}`}
          </p>
          <ol className="transcript" aria-label="Transcript">
            {chat.messages.map((message) => (
              <li key={message.id} className={`message role-${message.role}`}>
                <span className="message-role">{message.role}</span>
                <span className="message-body">{message.body}</span>
              </li>
            ))}
          </ol>
    </div>
  );

  const renderComposer = () => (
    <div className="chat-start">
          <h2 className="chat-heading">{COMPOSER_PROMPTS[promptIndex]}</h2>
          <div className="composer" onDrop={onComposerDrop} onDragOver={(event) => event.preventDefault()}>
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
              onKeyDown={onComposerKeyDown}
              onPaste={onComposerPaste}
              placeholder="Do anything"
              rows={3}
            />
            {attachmentChips}
            <div className="composer-bar">
              <div className="composer-controls">
                <WorkspacePicker
                  client={client}
                  roots={workspaceRoots}
                  value={workspaceRoot}
                  onSelect={setWorkspaceRoot}
                  onAddRoots={onAddWorkspaceRoots ?? (() => undefined)}
                  {...(defaultWorkspaceRoot === undefined
                    ? {}
                    : { defaultRoot: defaultWorkspaceRoot })}
                  {...(onSetDefaultWorkspaceRoot === undefined
                    ? {}
                    : { onSetDefault: onSetDefaultWorkspaceRoot })}
                />
                {attachButton}
                {modelControls}
              </div>
              <button
                type="button"
                className="composer-send"
                aria-label="Start session"
                onClick={onStart}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
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
              <>Launching {backendLabel(provider)}{model === undefined ? "" : ` · ${model}`}.</>
            )}
          </p>

          <RecentChats onOpen={setOpenedChat} />

          <SyncedHistory sessions={syncedSessions} onOpen={openSyncedSession} />
    </div>
  );

  const renderActiveRun = () => (
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
                <div
                  className="reply-box"
                  onDrop={canFollowUp ? onComposerDrop : undefined}
                  onDragOver={canFollowUp ? (event) => event.preventDefault() : undefined}
                >
                  <label htmlFor="reply">{needsInput ? "Reply" : "Follow up"}</label>
                  <input
                    id="reply"
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    onPaste={canFollowUp ? onComposerPaste : undefined}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void onSend();
                      }
                    }}
                  />
                  {/* Attachments ride with a follow-up (a new run), not a live in-process reply. */}
                  {canFollowUp && attachButton}
                  <button type="button" onClick={onSend}>
                    Send
                  </button>
                </div>
              )}
              {canFollowUp && attachmentChips}
              {active && (
                <button type="button" className="stop" onClick={onStop}>
                  Stop
                </button>
              )}
            </div>
          </div>

          {variant === "full" && (
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
          )}
    </div>
  );

  // Pick the body without a negated condition or a nested ternary: an opened history
  // chat wins; otherwise the composer (no active run) or the active run view.
  let body: ReactElement;
  if (openedChat !== undefined) {
    body = renderHistory(openedChat);
  } else if (runId === undefined) {
    body = renderComposer();
  } else {
    body = renderActiveRun();
  }

  return (
    <section className={`chat ${variant === "sidebar" ? "chat--sidebar" : ""}`} aria-label="Run">
      {error !== undefined && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {body}
    </section>
  );
}

function IconPaperclip(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3l7.8-7.8" />
    </svg>
  );
}

interface RecentChatsProps {
  /** Open a past chat read-only. The id is resolved to its full record here. */
  onOpen: (chat: ChatRecord | undefined) => void;
}

/** Locally-saved recent chats (top 8). A flat module-scope component so the click
    handler is not a deeply nested callback inside the composer render. Renders nothing
    when there is no local history. */
function RecentChats({ onOpen }: Readonly<RecentChatsProps>): ReactElement | null {
  const recents = loadChatSummaries().slice(0, 8);
  if (recents.length === 0) {
    return null;
  }
  return (
    <div className="recent-chats">
      <p className="eyebrow">Recent chats</p>
      <ul aria-label="Recent chats">
        {recents.map((chat) => (
          <li key={chat.id}>
            <button
              type="button"
              className="recent-chat"
              onClick={() => onOpen(getChat(chat.id))}
            >
              <span className="recent-task">{chat.task}</span>
              <span className="recent-meta">
                {chat.backend === undefined ? "-" : backendLabel(chat.backend)}
                {chat.model === undefined ? "" : ` · ${chat.model}`}
                {` · $${chat.totalUsd.toFixed(4)}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SyncedHistoryProps {
  /** Durable, bridge-backed past sessions. */
  sessions: DispatchSession[];
  /** Request a session's detail by id (reopened read-only when it arrives). */
  onOpen: (id: string) => void;
}

/** Durable synced history list. A flat module-scope component so its click handler is not
    a deeply nested callback inside the composer render. Renders nothing when empty. */
function SyncedHistory({ sessions, onOpen }: Readonly<SyncedHistoryProps>): ReactElement | null {
  if (sessions.length === 0) {
    return null;
  }
  return (
    <div className="recent-chats synced-history">
      <p className="eyebrow">Synced history</p>
      <ul aria-label="Synced history">
        {sessions.map((session) => (
          <li key={session.id}>
            <button type="button" className="recent-chat" onClick={() => onOpen(session.id)}>
              <span className="recent-task">{session.title}</span>
              <span className="recent-meta">{backendLabel(session.backend)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
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
