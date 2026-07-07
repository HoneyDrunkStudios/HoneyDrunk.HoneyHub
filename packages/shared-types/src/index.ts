export type AgentBackend = "claude.local" | "codex.local" | "copilot.local";

export type DispatchRunState =
  | "created"
  | "queued"
  | "starting"
  | "running"
  | "needs_input"
  | "finalizing"
  | "completed"
  | "stopping"
  | "failed"
  | "cancelled";

export type UsageFidelity = "exact" | "derived" | "estimated";

export interface CapabilityFlags {
  streaming_output: boolean;
  interactive_reply: boolean;
  resume_session: boolean;
  stop_signal: boolean;
  structured_events: boolean;
  /** Backend reports an exact cost (tokens + USD), taken directly. */
  usage_exact: boolean;
  /**
   * Backend reports exact token counts but no USD, so the dollar value is derived
   * from the operator-configurable rate table (ADR-0092 D2). At most one of the
   * three usage flags is set; the signal's own `fidelity` tag remains the
   * load-bearing honesty mechanism, these flags are the coarse handshake hint.
   */
  usage_derived: boolean;
  /** Backend exposes neither exact USD nor exact tokens, so figures are estimated. */
  usage_estimated: boolean;
}

export interface DispatchSession {
  id: string;
  backend: AgentBackend;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  currentRunId?: string;
  /** Pinned in the cockpit's history (sorts first; exempt from transcript pruning). */
  pinned?: boolean;
}

export interface DispatchRun {
  id: string;
  sessionId: string;
  state: DispatchRunState;
  task: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
}

export type DispatchMessageRole = "user" | "agent" | "system";

export interface DispatchMessage {
  id: string;
  sessionId: string;
  runId: string;
  role: DispatchMessageRole;
  body: string;
  createdAt: string;
  isPartial?: boolean;
}

export type DispatchControlEventKind =
  | "state_changed"
  | "launch"
  | "reply"
  | "follow_up"
  | "stop"
  | "resume"
  | "process_exit"
  | "approve"
  | "reject"
  | "timeout";

export interface DispatchControlEvent {
  id: string;
  sessionId: string;
  runId: string;
  kind: DispatchControlEventKind;
  createdAt: string;
  summary: string;
}

export type DispatchArtifactKind =
  | "branch"
  | "commit"
  | "pull_request"
  | "work_item"
  | "adr_draft"
  | "pdr_draft"
  | "report"
  | "log_bundle";

export interface DispatchArtifact {
  id: string;
  sessionId: string;
  runId: string;
  kind: DispatchArtifactKind;
  label: string;
  href?: string;
  repoRelativePath?: string;
  createdAt: string;
}

/** What an agent did during a run (tool/file activity), for the chat right-panel. */
export type ActivityKind = "read" | "edit" | "command" | "search" | "fetch" | "tool";

export interface DispatchActivity {
  id: string;
  sessionId: string;
  runId: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  createdAt: string;
}

export interface UsageSignal {
  id: string;
  sessionId: string;
  runId: string;
  backend: AgentBackend;
  fidelity: UsageFidelity;
  modelLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalUsd?: number;
  premiumRequests?: number;
  durationMs?: number;
  confidence?: "low" | "medium" | "high";
  recordedAt: string;
}

/**
 * A per-(backend, fidelity) rollup of usage across many turns. Backends with
 * different fidelity (exact / derived / estimated) stay in separate rollups so the
 * spend view never sums a measured cost together with an estimate (ADR-0092 D2).
 */
export interface UsageRollup {
  backend: AgentBackend;
  fidelity: UsageFidelity;
  /** Number of usage signals (billed turns) folded into this rollup. */
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Summed USD for signals that carried a cost; absent when none did. */
  totalUsd?: number;
  /** Summed premium requests (the real billing unit for estimated backends). */
  premiumRequests?: number;
  durationMs: number;
}

/**
 * Device-wide "your spend" summary: usage rolled up per (backend, fidelity), plus
 * a grounded USD total that deliberately excludes estimated spend. Cross-session
 * and local-only (ADR-0092 D1/D2) — nothing here syncs off-device.
 */
export interface UsageSummary {
  /** Distinct sessions that contributed at least one run. */
  sessionCount: number;
  /** Total billed turns across every rollup. */
  totalTurns: number;
  rollups: UsageRollup[];
  /**
   * Sum of USD across exact + derived rollups only — a real dollar figure.
   * Estimated backends (premium requests, not a token cost) are excluded so a
   * guess can never inflate the headline. Absent when no grounded signal had USD.
   */
  groundedTotalUsd?: number;
  /** Total premium requests across estimated backends, surfaced separately. */
  totalPremiumRequests: number;
}

/** Where a definition was found: a per-workspace repo folder, or the user-global home
 *  folder. A project definition shadows a global one within a backend. */
export type AgentScope = "project" | "global";

/**
 * One backend a discovered agent can run on, carrying the winning definition's
 * metadata for that backend (a project definition beats a global one). Metadata only —
 * the prompt body stays on disk. No absolute local path crosses the wire: `sourcePath`
 * is relative to its scan root and `workspaceLabel` is a basename (or the constant
 * `"global"`), never an absolute path.
 */
export interface AgentBackendBinding {
  backend: AgentBackend;
  description: string;
  model?: string;
  sourcePath: string;
  scope: AgentScope;
  workspaceLabel: string;
}

/**
 * A discovered, runnable agent (packet 09 §3f-bis), identified by **name** and runnable
 * on the **set of backends** that define it (one-entry-per-name model). Metadata only.
 * No absolute local path crosses the wire: `id` is an opaque hash of the name and every
 * per-backend path is relative.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  /** The backends this agent can run on, ordered by backend. Always non-empty. */
  backends: AgentBackendBinding[];
}

export type PolicyHintSeverity = "info" | "warning" | "block";

export interface PolicyHint {
  id: string;
  sessionId: string;
  runId?: string;
  code: string;
  severity: PolicyHintSeverity;
  message: string;
  createdAt: string;
}

/** A file the user attached to a chat turn (a document or a pasted/dropped image).
    Sent inline (base64) over the wire; the bridge writes it to a per-run temp dir and
    references the path in the task so the agent can read it. Kept backend-agnostic on
    purpose: every adapter gets attachments via path references, no per-CLI multimodal
    plumbing (HoneyHub attachments v1). */
export interface ChatAttachment {
  /** The original file name (the bridge sanitizes it to a safe basename before writing). */
  name: string;
  /** The MIME type when the browser reported one (e.g. `image/png`); informational. */
  mimeType?: string;
  /** Base64-encoded file contents, with no `data:` URI prefix. */
  data: string;
}

export interface StartRunRequest {
  session: DispatchSession;
  workspaceRoot: string;
  task: string;
  /** The model the user picked for this run (e.g. `opus`). Omitted = the adapter's
      configured/default model. Honored per-run so the model picker actually changes
      what launches (packet 09 §3c). */
  model?: string;
  /** A named agent to run under (Claude `--agent <name>`). Omitted = the default
      session agent. Codex has no agent flag, so it is ignored there (packet 09 §3d). */
  agent?: string;
  /** Reasoning effort (e.g. `high`) → Codex `-c model_reasoning_effort=`. Claude has no
      effort flag, so it is ignored there (parity polish #9). */
  effort?: string;
  requestedRunId?: string;
  followUpToRunId?: string;
  transcript?: DispatchMessage[];
  launchCommand?: string[];
  /** Files attached to this turn (documents, pasted/dropped images). The bridge
      materializes them to a temp dir and appends their paths to the task so the agent
      can read them. Omitted/empty = none. */
  attachments?: ChatAttachment[];
  /** The run that dispatched this one, when an agent started it through the
      `dispatch_agent` capability (ADR-0098 C). Omitted for every operator-started run.
      Additive on the wire so existing frames stay byte-compatible; paired with
      `parentSessionId` so a child records who dispatched it. */
  parentRunId?: string;
  /** The session of the dispatching parent (ADR-0098 C). Omitted for operator runs. */
  parentSessionId?: string;
}

/** Per-model USD pricing (per million tokens), when the bridge knows an authoritative
    rate. Powers pre-send estimates and derived cost; absent = unknown, never guessed. */
export interface ModelPricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

/** One model a backend can run, offered in the model picker. `id` is the value the
    CLI receives (e.g. `--model <id>`); `label` is human-facing. */
export interface BackendModel {
  id: string;
  label: string;
  /** Reasoning-effort levels this model supports (e.g. `low`/`medium`/`high`), when the
      CLI exposes them (Codex does; Claude has no effort flag). Omitted/empty = none. */
  reasoningLevels?: string[];
  /** The CLI's default reasoning level for this model, when known. */
  defaultReasoning?: string;
  /** Known per-token pricing; absent when the bridge has no authoritative rate. */
  pricing?: ModelPricing;
  /** True when running this model bills real dollars even on a flat subscription
      (usage credits / API metering) — never treat it as included-in-plan. */
  metered?: boolean;
}

/** How a backend's model list was sourced, so the UI is honest about provenance.
    `cli_cache` = read from the CLI's own model cache; `cli_alias` = the CLI's
    canonical aliases; `bridge_known` = a curated fallback. */
export type ModelSource = "cli_cache" | "cli_alias" | "bridge_known";

/** A backend's detected capability: whether its CLI is installed, the models it
    offers, and its honest capability flags. Reported by the bridge so the cockpit's
    first-run provider picker and model picker show only what's real. */
export interface BackendCapability {
  backend: AgentBackend;
  /** The program name probed on PATH (e.g. `claude`). */
  program: string;
  /** True when the program resolves on PATH (or is an existing path). */
  available: boolean;
  capabilities: CapabilityFlags;
  models: BackendModel[];
  defaultModel?: string;
  modelSource: ModelSource;
}

// --- Read-only filesystem browsing (packet 09 §3) ---
// The webview cannot read disk; the bridge browses directories (names only) for the
// repo/file picker and reads file CONTENTS (gated to the user's allowlisted roots).

export type DirEntryKind = "dir" | "file";

export interface DirEntry {
  name: string;
  kind: DirEntryKind;
  /** Size in bytes for files (omitted for directories). */
  size?: number;
}

export interface DirListing {
  /** The absolute directory listed. Empty string = the synthetic top level (drive
      roots on Windows, `/` on Unix). */
  path: string;
  /** The parent directory to navigate up to, if any (none at a drive/root). */
  parent?: string;
  entries: DirEntry[];
  /** True when the directory had more entries than the listing cap. */
  truncated: boolean;
}

export interface FileContents {
  path: string;
  content: string;
  /** True when the file exceeded the size cap and `content` is a prefix. */
  truncated: boolean;
  /** The file's full size in bytes (even when truncated). */
  byteSize: number;
}

/** The outcome of a host-owned file write (the in-app editor's Save), surfaced as
    feedback. A failed write is `ok: false` with the io error in `message`. */
export interface FileWriteResult {
  path: string;
  ok: boolean;
  message?: string;
}

/** A filename-search match (the in-repo file search). */
export interface SearchHit {
  path: string;
  name: string;
}

export interface SearchResults {
  root: string;
  query: string;
  hits: SearchHit[];
  /** True when a result/visited cap was hit before the walk finished. */
  truncated: boolean;
}

/** Which engine produced a content-search result set (ripgrep vs the Rust fallback), surfaced
    so the UI can be honest about capability — e.g. regex is ripgrep-only. */
export type ContentSearchEngine = "ripgrep" | "fallback";

/** One content-search match: a file, a 1-based line, an optional 1-based column of the match
    start, and the matched line's text. One row per matching line (matching ripgrep's default). */
export interface ContentMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start (character offset), when known. */
  column?: number;
  lineText: string;
}

/** Repo-wide content search results (VS Code's "Find in Files"): the flat match list (the UI
    groups by `path`), the distinct-file count, whether a cap truncated the walk, and the engine. */
export interface ContentSearchResults {
  root: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  matches: ContentMatch[];
  /** The number of distinct files in `matches`. */
  fileCount: number;
  /** True when the match/file cap was hit before the walk finished (some matches were dropped). */
  truncated: boolean;
  engine: ContentSearchEngine;
}

/** The repo folders a `.code-workspace` file references, resolved to absolute dirs. */
export interface WorkspaceFolders {
  workspaceFile: string;
  folders: string[];
}

/** Where an authored agent was written. `sourcePath` is relative to its scan root
    (no absolute local path crosses the wire), `scope` mirrors discovery's [`AgentScope`]. */
export interface AgentWriteOutcome {
  name: string;
  sourcePath: string;
  scope: AgentScope;
}

// --- Local jobs (control-hub roadmap #7) ---
// A read-only snapshot of the machine's processes + curated known-job health, so the
// cockpit can show what's running and what's down. Identity is by image name only.

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Resident memory in KiB, when the OS lister reports it. */
  memoryKb?: number;
  /** The full command line, when available (Windows CIM / Unix `ps args`). */
  command?: string;
}

/** A user-defined job probe (configurable job patterns): a label and the substrings that
    identify it, matched against each process's image name + command line. Sent with
    `list_jobs` and merged onto the built-in probes server-side. */
export interface JobProbe {
  label: string;
  patterns: string[];
}

export interface KnownJob {
  label: string;
  patterns: string[];
  running: boolean;
  instances: number;
  pids: number[];
  /** Summed resident memory (KiB) across matched processes. */
  memoryKb: number;
}

/** A user Windows Scheduled Task (non-`\Microsoft\`) — a local job with a state + last
    result. `lastResult: 0` = success; non-zero = an issue. Empty off Windows. */
export interface ScheduledTask {
  name: string;
  path: string;
  state: string;
  lastRun?: string;
  lastResult?: number;
  nextRun?: string;
}

export interface JobSnapshot {
  known: KnownJob[];
  scheduled: ScheduledTask[];
  processes: ProcessInfo[];
  /** True when the process list was capped before crossing the wire. */
  truncated: boolean;
}

// --- Roadmap (control-hub #6): parsed from an Architecture repo's initiatives ---

export interface RoadmapItem {
  rank: number;
  lane: string;
  item: string;
  /** The "Type" column (e.g. `initiative`, `packet`). */
  kind: string;
  status: string;
  phase: string;
  due: string;
  blockedBy?: string;
  whyNow?: string;
  exitCriteria?: string;
}

export interface RoadmapLane {
  lane: string;
  items: RoadmapItem[];
  /** The first non-blocked item — "what's next" for this lane. */
  next?: RoadmapItem;
}

export interface RoadmapSnapshot {
  /** True when the Architecture initiatives file was found + parsed. */
  found: boolean;
  /** The file path read (or attempted/empty), for the UI's guidance. */
  source: string;
  lastReviewed?: string;
  lanes: RoadmapLane[];
}

// --- CLI environment / updates (control-hub roadmap #8) ---
// The installed version of each backend CLI. Installed-only (no registry "latest" lookup),
// so the UI never claims an update is available; new-model awareness is a client-side diff
// of the detected catalog against the last-seen set.

export interface BackendVersion {
  backend: AgentBackend;
  program: string;
  available: boolean;
  version?: string;
}

export interface EnvironmentInfo {
  backends: BackendVersion[];
}

// --- Reachable network addresses (mobile pairing: "Connect a phone") ---
// This host's non-loopback IPv4 addresses, classified so the cockpit can show which one a
// phone should use (a tailnet address, or one on the same LAN). Surfacing an address does
// NOT by itself make the host reachable on it — the host must also be bound to a reachable
// interface; the cockpit explains that honestly.

export type NetAddressKind = "tailnet" | "lan" | "other";

export interface NetAddress {
  ip: string;
  kind: NetAddressKind;
  /** The interface this address belongs to, when the OS lister reports it. */
  interface?: string;
}

export interface NetworkInfo {
  /** Reachable IPv4 addresses, tailnet first, then LAN, then other. */
  addresses: NetAddress[];
}

// --- Work connectors (opt-in, read-only): "view everything assigned to me" ---
// Normalized work items pulled from the tools the operator already uses (GitHub now, ADO
// next). Each source is a connector the cockpit enables explicitly; the bridge only reads.

export type WorkItemKind = "issue" | "pull_request" | "work_item";

export interface WorkItem {
  /** Stable id for de-dup / keys (the item URL). */
  id: string;
  /** Connector id this came from (`github`, later `ado`). */
  source: string;
  kind: WorkItemKind;
  /** Clean bucket for the split view (e.g. `Assigned`, `Authored`, `Review requested`). */
  category: string;
  title: string;
  /** `owner/name` (GitHub) or project (ADO). */
  repository: string;
  url: string;
  state: string;
  number?: number;
  updatedAt?: string;
  labels?: string[];
}

export interface WorkSource {
  source: string;
  available: boolean;
  /** A short, non-leaking hint when the connector couldn't be read (e.g. not signed in). */
  error?: string;
  items?: WorkItem[];
}

export interface WorkSnapshot {
  sources: WorkSource[];
}

// --- Observability connector: Azure Service Bus (opt-in, read-only management plane) ---

export type ServiceBusEntityKind = "queue" | "subscription";

export interface ServiceBusEntity {
  name: string;
  kind: ServiceBusEntityKind;
  namespace: string;
  /** Parent topic, for a subscription. */
  topic?: string;
  status: string;
  active: number;
  deadLetter: number;
  scheduled: number;
}

export interface ServiceBusNamespace {
  name: string;
  resourceGroup: string;
  location?: string;
  entities: ServiceBusEntity[];
}

export interface ServiceBusSnapshot {
  available: boolean;
  /** A short, non-leaking hint when unavailable (e.g. not signed in). */
  error?: string;
  namespaces: ServiceBusNamespace[];
}

// --- Observability connector: Azure Key Vault (opt-in, read-only, via `az` on the host) ---

/** One Azure subscription the signed-in account can see (`az account list`). */
export interface AzureSubscription {
  id: string;
  name: string;
  /** The CLI's current default subscription; the cockpit pre-selects it. */
  isDefault: boolean;
  tenantId?: string;
  state?: string;
}

export interface AzureSubscriptionList {
  available: boolean;
  /** A short, non-leaking hint when unavailable (no `az` / not signed in). */
  error?: string;
  subscriptions: AzureSubscription[];
}

/** One Key Vault (`az keyvault list`), tagged with the subscription it came from. */
export interface KeyVault {
  name: string;
  resourceGroup: string;
  location?: string;
  subscriptionId: string;
  /** The vault's data-plane URI (`https://<name>.vault.azure.net/`), when reported. */
  uri?: string;
}

export interface KeyVaultList {
  available: boolean;
  /** A short, non-leaking hint when unavailable (no `az` / not signed in). */
  error?: string;
  /** Echoes the requested subscription ids, so the UI can ignore a stale response that no
      longer matches the current selection (out-of-order responses). */
  subscriptionIds?: string[];
  /** Selected subscriptions that could not be read (best-effort partial success), so the UI can
      warn instead of silently showing "no vaults". */
  unreadable?: string[];
  vaults: KeyVault[];
}

/** The kind of object inside a vault (each has its own data-plane list call). */
export type VaultObjectKind = "secret" | "key" | "certificate";

/** One secret / key / certificate's metadata (never its value). `expires` drives the expiry
    badges; it is the `attributes.expires` instant (ISO-8601, or a numeric unix-seconds string). */
export interface VaultObject {
  name: string;
  kind: VaultObjectKind;
  enabled: boolean;
  expires?: string;
  created?: string;
  updated?: string;
  /** The secret's content type (secrets only), when set. */
  contentType?: string;
}

/** The objects inside one vault. `vault` + `subscriptionId` are echoed so the cockpit can
    correlate the response with the row it expanded. */
export interface VaultObjects {
  available: boolean;
  /** A short, non-leaking hint when unavailable (no access / not signed in). */
  error?: string;
  vault: string;
  subscriptionId: string;
  objects: VaultObject[];
}

/** The result of revealing one secret's value (the gated "view it" action). The `value` is
    sensitive: it rides the local bridge on demand only and is never persisted or logged. */
export interface SecretReveal {
  ok: boolean;
  error?: string;
  vault: string;
  subscriptionId: string;
  name: string;
  value?: string;
}

/** One secret/key/certificate that carries an expiry, with its vault + subscription. `expires` is
    always present (only objects with an expiry are scanned); the cockpit applies the threshold. */
export interface ExpiringObject {
  vault: string;
  subscriptionId: string;
  kind: VaultObjectKind;
  name: string;
  expires: string;
}

/** Objects-with-an-expiry across the selected subscriptions' vaults, for the background expiry
    notifications. */
export interface ExpiringObjects {
  available: boolean;
  error?: string;
  /** The subscriptions this scan covered (echoed from the request), so the cockpit can discard a
      stale result whose selection has since changed before alerting or warning. */
  subscriptionIds?: string[];
  /** True when the account has more vaults than the scan cap, so coverage is incomplete (the UI
      tells the operator rather than implying "no alert" means "nothing expiring"). */
  truncated?: boolean;
  /** Vaults whose contents could not be read this scan (partial coverage). */
  unreadable?: string[];
  objects: ExpiringObject[];
}

// Non-destructive message peek (ADR-0094 D5), via the optional `honeyhub-sb-explorer` helper.
export interface PeekMessage {
  messageId?: string;
  sequenceNumber: number;
  enqueuedTime?: string;
  subject?: string;
  deliveryCount: number;
  body: string;
  deadLetterReason?: string;
}

export interface ServiceBusPeek {
  available: boolean;
  /** A short, non-leaking hint when unavailable (helper not installed / not signed in). */
  error?: string;
  namespace: string;
  entity: string;
  subscription?: string;
  deadLetter: boolean;
  messages: PeekMessage[];
}

// DESTRUCTIVE dead-letter resubmit (ADR-0094 D5 write op) — confirmation-gated in the UI.
export interface ServiceBusResubmit {
  ok: boolean;
  error?: string;
  /** How many dead-letter messages were moved back to the source. */
  moved: number;
  namespace: string;
  entity: string;
  subscription?: string;
}

// DESTRUCTIVE purge (ADR-0094 D5 write op) — drains all messages; confirmation-gated in the UI.
export interface ServiceBusPurge {
  ok: boolean;
  error?: string;
  /** How many messages were drained. */
  purged: number;
  namespace: string;
  entity: string;
  subscription?: string;
  deadLetter: boolean;
}

// Publish a message (ADR-0094 D5 write op) — confirmation-gated in the UI.
export interface ServiceBusSend {
  ok: boolean;
  error?: string;
  namespace: string;
  entity: string;
}

// DESTRUCTIVE receive (ADR-0094 D5 write op) — consumes+removes one message; confirmation-gated.
export interface ServiceBusReceive {
  ok: boolean;
  error?: string;
  /** The consumed message, or absent when the entity was empty. */
  message?: PeekMessage;
  empty: boolean;
  namespace: string;
  entity: string;
  subscription?: string;
  deadLetter: boolean;
}

// --- Service Bus connections: entity listing + management (admin client) ---

/** Editable entity properties (a focused subset). Reported for an entity's current settings
    and used to request changes; an absent field on a manage request leaves it unchanged. */
export interface SbEntityProps {
  maxSizeMb?: number;
  maxDeliveryCount?: number;
  lockDurationSeconds?: number;
  defaultTtlSeconds?: number;
  deadLetterOnExpiration?: boolean;
  status?: string;
}

export interface SbQueue {
  name: string;
  status: string;
  active: number;
  deadLetter: number;
  scheduled: number;
  props: SbEntityProps;
}

export interface SbSubscription {
  name: string;
  status: string;
  active: number;
  deadLetter: number;
  props: SbEntityProps;
}

export interface SbTopic {
  name: string;
  status: string;
  props: SbEntityProps;
  subscriptions: SbSubscription[];
}

/** The entities of one connection's namespace (the per-connection explorer view). */
export interface ServiceBusEntities {
  available: boolean;
  error?: string;
  namespace: string;
  queues: SbQueue[];
  topics: SbTopic[];
}

/** The result of a Service Bus management write (create/delete/update of an entity). */
export interface ServiceBusManage {
  ok: boolean;
  error?: string;
  namespace: string;
  op: string;
  kind: string;
  entity: string;
  subscription?: string;
  message?: string;
}

// --- Observability connector: Grafana (opt-in, read-only summary + deep-links) ---

export interface GrafanaDashboard {
  title: string;
  uid: string;
  /** Absolute browser URL to open the dashboard. */
  url: string;
  folder?: string;
}

export interface GrafanaSummary {
  available: boolean;
  error?: string;
  /** The base URL this summary is for (so the UI can build deep-links). */
  baseUrl: string;
  version?: string;
  database?: string;
  dashboards: GrafanaDashboard[];
}

// --- Observability connector: Sentry (opt-in, read-only unresolved issues) ---

export interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  level: string;
  count: number;
  userCount: number;
  permalink: string;
  lastSeen?: string;
}

export interface SentrySummary {
  available: boolean;
  error?: string;
  issues: SentryIssue[];
}

// --- Git status + read-only diff (parity polish #9) ---

export interface GitFileStatus {
  path: string;
  /** The two-character porcelain XY code (e.g. ` M`, `A `, `??`). */
  status: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  root: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  clean: boolean;
}

export interface GitDiff {
  root: string;
  path?: string;
  patch: string;
  truncated: boolean;
}

/** Both versions of a single file for a side-by-side diff: its content at `HEAD` (the
    committed baseline) and in the working tree. Powers the Monaco `DiffEditor`, which needs
    the two full texts rather than a unified patch. `existedInHead` distinguishes a new file
    (empty original) from an empty one; `existedInWork` distinguishes a deleted file. */
export interface GitFileVersions {
  root: string;
  path: string;
  original: string;
  modified: string;
  existedInHead: boolean;
  existedInWork: boolean;
}

/** The status of every repo discovered under a selected folder (or just the one repo when
    the selected root is itself a repo). Powers the multi-repo Git dashboard. */
export interface GitOverview {
  root: string;
  repos: GitStatus[];
}

/** A repo's local branches and the checked-out one (for the branch switcher). */
export interface GitBranches {
  root: string;
  current?: string;
  branches: string[];
}

/** The outcome of a git write op (stage/commit/push/pull/checkout/discard), surfaced as
    feedback. The host also re-emits a fresh GitStatus so the view updates. */
export interface GitOpResult {
  root: string;
  op: string;
  ok: boolean;
  message?: string;
}

/** How a check request was disposed of — explicit, so denied/timed-out runs are
    observable states rather than indistinguishable failures. */
export type CheckDisposition = "ran" | "denied" | "spawn_failed" | "timed_out";

/** WHY a request was denied — typed, so clients fold denials on a stable code
    instead of matching the human-readable message. Only `overlap` is non-terminal
    for a requester (the in-flight run's real outcome is still coming). */
export type CheckDenialReason = "overlap" | "unknown_check" | "task_failed";

/** The outcome of running one **named, host-owned** check (a repo's build/test) in a
    repo root — the "test a change group" action. The client sends only a check id;
    the host resolves it against its own definitions and refuses anything else. Argv
    is spawned shell-free with a timeout; a refusal, spawn failure, or timeout
    surfaces as `ok: false` with its disposition and the reason in `output`. */
export interface CheckOutcome {
  root: string;
  /** The check id as requested (echoed for correlation). */
  check: string;
  /** The resolved command line (display only). */
  command: string;
  ok: boolean;
  disposition: CheckDisposition;
  /** The process exit code, when one was returned (absent on signal/spawn failure). */
  exitCode?: number;
  /** The typed reason when `disposition` is `denied`; absent otherwise (and absent
      from hosts predating the field, where clients fall back to the message). */
  denial?: CheckDenialReason;
  /** Combined stdout + stderr, trimmed and clamped. */
  output: string;
  /** True when `output` was clamped. */
  truncated: boolean;
}

export interface RunHandle {
  runId: string;
  processId?: number;
}

export type WireProtocolVersion = "honeyhub.bridge.v1";

export const wireProtocolVersion: WireProtocolVersion = "honeyhub.bridge.v1";

export type WireFrameKind = "client_command" | "server_event" | "ack" | "error";

export type ClientCommand =
  | { kind: "start"; request: StartRunRequest }
  | { kind: "reply"; runId: string; text: string }
  | { kind: "stop"; runId: string }
  | { kind: "resume"; sessionIdOrTranscript: string }
  | { kind: "reconnect"; request: ReconnectRequest }
  | { kind: "usage_summary" }
  | { kind: "coaching_hints" }
  | { kind: "discover_agents"; workspaceRoot?: string }
  | { kind: "discover_backends" }
  | { kind: "set_workspace_roots"; roots: string[] }
  | { kind: "browse_dir"; path?: string }
  | { kind: "read_file"; path: string }
  | { kind: "write_file"; path: string; content: string }
  | { kind: "search_files"; root: string; query: string }
  | {
      kind: "search_content";
      root: string;
      query: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      isRegex?: boolean;
    }
  | { kind: "resolve_workspace_file"; path: string }
  | {
      kind: "write_agent";
      name: string;
      description: string;
      body: string;
      model?: string;
      workspaceRoot?: string;
    }
  | { kind: "list_jobs"; extraProbes?: JobProbe[]; extraTaskKeywords?: string[] }
  | { kind: "detect_environment" }
  | { kind: "list_network" }
  | { kind: "list_work"; sources?: string[] }
  | { kind: "list_service_bus" }
  | { kind: "list_azure_subscriptions" }
  | { kind: "list_key_vaults"; subscriptionIds?: string[] }
  | { kind: "list_vault_objects"; vault: string; subscriptionId: string }
  | { kind: "reveal_secret"; vault: string; subscriptionId: string; name: string }
  | { kind: "scan_key_vault_expiry"; subscriptionIds?: string[] }
  | {
      kind: "peek_service_bus";
      namespace: string;
      connectionString?: string;
      entity: string;
      subscription?: string;
      deadLetter?: boolean;
      count?: number;
    }
  | {
      kind: "resubmit_dead_letter";
      namespace: string;
      connectionString?: string;
      entity: string;
      subscription?: string;
      count?: number;
    }
  | {
      kind: "purge_service_bus";
      namespace: string;
      connectionString?: string;
      entity: string;
      subscription?: string;
      deadLetter?: boolean;
    }
  | {
      kind: "send_service_bus";
      namespace: string;
      connectionString?: string;
      entity: string;
      body: string;
      subject?: string;
      contentType?: string;
    }
  | {
      kind: "receive_service_bus";
      namespace: string;
      connectionString?: string;
      entity: string;
      subscription?: string;
      deadLetter?: boolean;
    }
  | { kind: "list_service_bus_entities"; namespace: string; connectionString?: string }
  | {
      kind: "manage_service_bus";
      namespace: string;
      connectionString?: string;
      op: string;
      entityKind: string;
      entity: string;
      subscription?: string;
      props?: SbEntityProps;
    }
  | { kind: "grafana_summary"; baseUrl: string; token?: string }
  | { kind: "sentry_summary"; baseUrl?: string; org: string; project: string; token?: string }
  | { kind: "git_status"; root: string }
  | { kind: "git_diff"; root: string; path?: string }
  | { kind: "git_file_versions"; root: string; path: string }
  | { kind: "git_overview"; root: string }
  | { kind: "git_branches"; root: string }
  | { kind: "git_stage"; root: string; paths: string[] }
  | { kind: "git_unstage"; root: string; paths: string[] }
  | { kind: "git_commit"; root: string; message: string }
  | { kind: "git_push"; root: string }
  | { kind: "git_pull"; root: string }
  | { kind: "git_checkout"; root: string; name: string; create?: boolean }
  | { kind: "git_discard"; root: string; paths: string[]; untracked?: boolean }
  | { kind: "git_discard_all"; root: string }
  | { kind: "git_delete_branch"; root: string; name: string; force?: boolean }
  | { kind: "list_sessions" }
  | { kind: "session_detail"; sessionId: string }
  | { kind: "rename_session"; sessionId: string; title: string }
  | { kind: "delete_session"; sessionId: string }
  | { kind: "pin_session"; sessionId: string; pinned: boolean }
  | { kind: "probe_usage"; backend: AgentBackend }
  | { kind: "roadmap" }
  | { kind: "scaffold_architecture"; name?: string; location?: string }
  | { kind: "pull_architecture" }
  | { kind: "run_check"; root: string; check: string }
  // LSP (ADR-0102): start/reuse an allowlisted server, forward a JSON-RPC message, stop.
  // The client sends a language id + root (never a command line); `message` is an opaque
  // LSP JSON-RPC message the bridge frames verbatim to the server's stdin.
  | { kind: "lsp_start"; root: string; languageId: string }
  | { kind: "lsp_send"; root: string; languageId: string; message: unknown }
  | { kind: "lsp_stop"; root: string; languageId: string }
  // Integrated terminal (ADR-0103): open a PTY-backed shell in an allowlisted root
  // (desktop-local-only; a relay connection is refused), feed it base64 keystrokes, resize
  // its PTY, and close it (tree-killing the shell). `data` is base64 of the raw bytes.
  | { kind: "terminal_open"; root: string; cols?: number; rows?: number; openId?: string }
  | { kind: "terminal_input"; sessionId: string; data: string }
  | { kind: "terminal_resize"; sessionId: string; cols: number; rows: number }
  | { kind: "terminal_close"; sessionId: string };

export interface ReconnectRequest {
  sessionId: string;
  runId?: string;
  lastEventId?: string;
}

export interface WireFrame {
  protocol: WireProtocolVersion;
  frameId: string;
  kind: WireFrameKind;
  createdAt: string;
  command?: ClientCommand;
  event?: BridgeEvent;
  error?: {
    code: string;
    message: string;
  };
  ackFrameId?: string;
}

export interface BridgeEvent {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
  createdAt: string;
  payload: BridgeEventPayload;
}

export type BridgeEventPayload =
  | { kind: "message"; message: DispatchMessage }
  | { kind: "control"; event: DispatchControlEvent }
  | { kind: "usage"; signal: UsageSignal }
  | { kind: "policy_hint"; hint: PolicyHint }
  | { kind: "status"; status: BridgeStatusEvent }
  | { kind: "artifact"; artifact: DispatchArtifact }
  | { kind: "activity"; activity: DispatchActivity }
  | { kind: "usage_summary"; summary: UsageSummary }
  | { kind: "coaching_hints"; hints: PolicyHint[] }
  | { kind: "agent_catalog"; agents: AgentDefinition[] }
  | { kind: "backend_catalog"; backends: BackendCapability[] }
  | { kind: "dir_listing"; listing: DirListing }
  | { kind: "file_contents"; file: FileContents }
  | { kind: "file_written"; result: FileWriteResult }
  | { kind: "search_results"; results: SearchResults }
  | { kind: "content_search_results"; results: ContentSearchResults }
  | { kind: "workspace_folders"; folders: WorkspaceFolders }
  | { kind: "agent_written"; agent: AgentWriteOutcome }
  | { kind: "job_snapshot"; snapshot: JobSnapshot }
  | { kind: "environment_info"; environment: EnvironmentInfo }
  | { kind: "network_info"; network: NetworkInfo }
  | { kind: "work_snapshot"; snapshot: WorkSnapshot }
  | { kind: "service_bus_snapshot"; snapshot: ServiceBusSnapshot }
  | { kind: "azure_subscriptions"; subscriptions: AzureSubscriptionList }
  | { kind: "key_vaults"; vaults: KeyVaultList }
  | { kind: "vault_objects"; objects: VaultObjects }
  | { kind: "secret_reveal"; reveal: SecretReveal }
  | { kind: "key_vault_expiry"; expiring: ExpiringObjects }
  | { kind: "service_bus_peek"; peek: ServiceBusPeek }
  | { kind: "service_bus_resubmit"; result: ServiceBusResubmit }
  | { kind: "service_bus_purge"; result: ServiceBusPurge }
  | { kind: "service_bus_send"; result: ServiceBusSend }
  | { kind: "service_bus_receive"; result: ServiceBusReceive }
  | { kind: "service_bus_entities"; entities: ServiceBusEntities }
  | { kind: "service_bus_manage"; result: ServiceBusManage }
  | { kind: "grafana_summary"; summary: GrafanaSummary }
  | { kind: "sentry_summary"; summary: SentrySummary }
  | { kind: "git_status"; status: GitStatus }
  | { kind: "git_diff"; diff: GitDiff }
  | { kind: "git_file_versions"; result: GitFileVersions }
  | { kind: "git_overview"; overview: GitOverview }
  | { kind: "git_branches"; branches: GitBranches }
  | { kind: "git_op"; result: GitOpResult }
  /** Host-pushed: files changed on disk under the watched workspace roots (debounced). The
      Browse + Git surfaces refresh in response. `paths` are the changed file/dir paths. */
  | { kind: "fs_changed"; paths: string[] }
  | { kind: "session_list"; sessions: DispatchSession[] }
  | {
      kind: "session_detail";
      sessionId: string;
      runs: DispatchRun[];
      transcript: DispatchMessage[];
      /** The session's usage rolled up per (backend, fidelity) — the per-thread cost
          view. Absent when the session recorded no usage signals. */
      usage?: UsageSummary;
    }
  | { kind: "roadmap"; roadmap: RoadmapSnapshot }
  | { kind: "check_result"; result: CheckOutcome }
  | { kind: "usage_probe"; report: UsageProbeReport }
  // LSP (ADR-0102): one JSON-RPC message from a running language server, and a lifecycle /
  // capability signal. Both host-synthesized + device-wide (empty session/run ids). The
  // cockpit routes `lsp_message` to the matching (languageId, root) client; `lsp_status`
  // is the honest degradation flag (keep in-file IntelliSense when installed/running false).
  | { kind: "lsp_message"; root: string; languageId: string; message: unknown }
  | { kind: "lsp_status"; status: LspStatus }
  // Integrated terminal (ADR-0103): a session opened, one chunk of output (`data` is base64
  // of the raw PTY bytes), and a session's end (`reason` is a short opaque code). All three
  // are host-synthesized + device-wide (empty session/run ids); the cockpit routes them to
  // the pane matching `sessionId`. Terminal output is never persisted (envelope-audit-only).
  | { kind: "terminal_opened"; sessionId: string; openId?: string }
  | { kind: "terminal_output"; sessionId: string; data: string }
  | { kind: "terminal_closed"; sessionId: string; reason: string };

/** A language-server lifecycle / capability signal (ADR-0102). Mirrors the bridge's serde
    shape. `installed`/`running` are the graceful-degradation flags: when either is false the
    cockpit keeps its in-file Monaco IntelliSense and shows a quiet note. */
export interface LspStatus {
  /** The workspace root the server is (or would be) scoped to. */
  root: string;
  /** The Monaco language id this status is about. */
  languageId: string;
  /** The resolved allowlist server id, or empty when no server is allowlisted. */
  serverId: string;
  /** True when a server binary was located on PATH (operator-installed). */
  installed: boolean;
  /** True when a supervised server process is currently running for this key. */
  running: boolean;
  /** A short human-readable reason, for a quiet cockpit note. */
  reason: string;
}

/** One meter line scraped from a vendor CLI's usage panel. */
export interface UsageWindow {
  /** The cleaned line as the vendor rendered it (label + numbers + reset time). */
  line: string;
  /** The first percentage on the line, when one parsed — powers a meter bar. */
  usedPercent?: number;
}

/** The outcome of probing one backend's plan-usage meters (the TUI-only /usage and
    /status panels, captured via a hidden host-owned PTY). Numbers are the vendor's
    own meters as of `capturedAt`; when parsing found nothing, `raw` is the answer. */
export interface UsageProbeReport {
  backend: AgentBackend;
  ok: boolean;
  windows: UsageWindow[];
  raw: string;
  capturedAt: string;
}

export interface BridgeStatusEvent {
  state: DispatchRunState;
  backend: AgentBackend;
  repoHint?: string;
  link?: string;
}

// --- Pairing + trust boundary (ADR-0090 D8) ---
// These mirror the bridge's serde shapes. Only token-free views ever reach a sync
// surface, transcript, or notification; the plaintext pairing token appears once
// in PairingGrant (the handshake response) and is never re-surfaced after that
// single hop (ADR-0090 D8 no-secret-leak posture).

export interface BridgeIdentityView {
  deviceId: string;
  displayName: string;
}

export interface PairedDeviceView {
  deviceId: string;
  displayName: string;
  pairedAt: string;
  revoked: boolean;
}

export interface PairingGrant {
  device: PairedDeviceView;
  token: string;
}

// --- State-only notifications (ADR-0090 D7) ---
// A notification carries status/backend/repo/link only — by shape it cannot hold
// prompt text, code, secrets, stack traces, or full paths.

export type NotificationKind =
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "pr_opened";

export interface Notification {
  id: string;
  kind: NotificationKind;
  sessionId: string;
  runId: string;
  backend: AgentBackend;
  repo?: string;
  link?: string;
  createdAt: string;
}

export const defaultClaudeCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: true,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: true,
  usage_derived: false,
  usage_estimated: false
};

/**
 * `codex.local`: message-level streaming, resume-based reply (follow-up-run path),
 * stop + resume, exact tokens with a derived (rate-table) USD.
 */
export const defaultCodexCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: false,
  usage_derived: true,
  usage_estimated: false
};

/**
 * `copilot.local`: token-level streaming, resume-based reply, stop + resume, and
 * premium-requests + duration only, so token/USD figures are estimated.
 */
export const defaultCopilotCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: true,
  stop_signal: true,
  structured_events: true,
  usage_exact: false,
  usage_derived: false,
  usage_estimated: true
};

export const oneShotCapabilities: CapabilityFlags = {
  streaming_output: true,
  interactive_reply: false,
  resume_session: false,
  stop_signal: false,
  structured_events: false,
  usage_exact: false,
  usage_derived: false,
  usage_estimated: true
};
