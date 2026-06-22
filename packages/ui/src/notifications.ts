import type {
  ExpiringObject,
  ExpiringObjects,
  ServiceBusSnapshot,
  WorkItem,
  WorkSnapshot
} from "@honeydrunk/honeyhub-types";
import { parseInstantMs } from "./routes/observe/keyVaultModel";

// Client-side notification model + pure detection helpers. The cockpit subscribes to the
// bridge's existing events (run status, work snapshot, Service Bus snapshot) and polls the
// connectors, then diffs against a "seen" set to fire OS toasts + an in-app feed. All the
// detection logic here is pure (takes `now` in) so it is unit-testable; the effectful wiring
// (subscriptions, polling, OS toasts) lives in the engine hook.

export type AppNotificationKind =
  | "chat_finished"
  | "work_assigned"
  | "work_mentioned"
  | "pr_review"
  | "dead_letter"
  | "secret_expiring";

export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  read: boolean;
}

/** Per-type toggles (all on by default). `desktop` gates OS toasts (also needs browser
    permission); the rest gate each trigger regardless of surface. */
export interface NotificationPrefs {
  desktop: boolean;
  chatFinished: boolean;
  workAssigned: boolean;
  workMentioned: boolean;
  prReview: boolean;
  deadLetter: boolean;
  secretExpiring: boolean;
  /** Days ahead within which an upcoming Key Vault expiry triggers an alert. */
  secretExpiryDays: number;
}

export const defaultNotificationPrefs: NotificationPrefs = {
  desktop: true,
  chatFinished: true,
  workAssigned: true,
  workMentioned: true,
  prReview: true,
  deadLetter: true,
  secretExpiring: true,
  secretExpiryDays: 30
};

/** Bounds for the expiry-window setting (days). */
export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 365;

/** Clamp a (possibly bad) expiry-days value into range, falling back to the default. */
export function clampExpiryDays(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultNotificationPrefs.secretExpiryDays;
  }
  return Math.min(MAX_EXPIRY_DAYS, Math.max(MIN_EXPIRY_DAYS, Math.round(value)));
}

const PREFS_KEY = "honeyhub.notificationPrefs.v1";
const FEED_KEY = "honeyhub.notificationFeed.v1";
const FEED_CAP = 50;

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (raw === null || raw === undefined) {
      return defaultNotificationPrefs;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return defaultNotificationPrefs;
    }
    const record = parsed as Record<string, unknown>;
    const bool = (key: keyof NotificationPrefs): boolean =>
      typeof record[key] === "boolean"
        ? (record[key] as boolean)
        : (defaultNotificationPrefs[key] as boolean);
    return {
      desktop: bool("desktop"),
      chatFinished: bool("chatFinished"),
      workAssigned: bool("workAssigned"),
      workMentioned: bool("workMentioned"),
      prReview: bool("prReview"),
      deadLetter: bool("deadLetter"),
      secretExpiring: bool("secretExpiring"),
      secretExpiryDays:
        typeof record.secretExpiryDays === "number"
          ? clampExpiryDays(record.secretExpiryDays)
          : defaultNotificationPrefs.secretExpiryDays
    };
  } catch {
    return defaultNotificationPrefs;
  }
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort.
  }
}

export function loadNotificationFeed(): AppNotification[] {
  try {
    const raw = globalThis.localStorage?.getItem(FEED_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is AppNotification =>
        typeof item === "object" && item !== null && typeof (item as AppNotification).id === "string"
    );
  } catch {
    return [];
  }
}

export function saveNotificationFeed(feed: AppNotification[]): void {
  try {
    globalThis.localStorage?.setItem(FEED_KEY, JSON.stringify(feed.slice(0, FEED_CAP)));
  } catch {
    // Best-effort.
  }
}

/** Whether a notification kind is enabled in prefs. */
export function isKindEnabled(prefs: NotificationPrefs, kind: AppNotificationKind): boolean {
  switch (kind) {
    case "chat_finished":
      return prefs.chatFinished;
    case "work_assigned":
      return prefs.workAssigned;
    case "work_mentioned":
      return prefs.workMentioned;
    case "pr_review":
      return prefs.prReview;
    case "dead_letter":
      return prefs.deadLetter;
    case "secret_expiring":
      return prefs.secretExpiring;
  }
}

/** Map a work-item category (any connector) to the notification kind it triggers, or undefined
    for categories that shouldn't notify (e.g. "Authored"). */
export function kindForCategory(category: string): AppNotificationKind | undefined {
  switch (category.trim().toLowerCase()) {
    case "assigned":
      return "work_assigned";
    case "mentioned":
      return "work_mentioned";
    case "review requested":
      return "pr_review";
    default:
      return undefined;
  }
}

function titleForKind(kind: AppNotificationKind): string {
  switch (kind) {
    case "chat_finished":
      return "Chat finished";
    case "work_assigned":
      return "Assigned to you";
    case "work_mentioned":
      return "You were mentioned";
    case "pr_review":
      return "PR needs your review";
    case "dead_letter":
      return "New dead-letter message";
    case "secret_expiring":
      return "Key Vault secret expiring";
  }
}

/** Every work item across the available sources (source-agnostic: GitHub, ADO, …). */
export function collectWorkItems(snapshot: WorkSnapshot): WorkItem[] {
  return snapshot.sources.flatMap((source) => (source.available ? (source.items ?? []) : []));
}

/** New work notifications: items not in `seen` whose category maps to an enabled kind. Returns
    the notifications to fire plus the full current id list (the caller stores it as the new
    `seen`, so resolved items drop out and a first snapshot seeds without firing when `seen` is
    pre-populated by the engine). */
export function workNotifications(
  snapshot: WorkSnapshot,
  prefs: NotificationPrefs,
  seen: ReadonlySet<string>,
  now: string
): { notifications: AppNotification[]; ids: string[] } {
  const items = collectWorkItems(snapshot);
  const notifications: AppNotification[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    const kind = kindForCategory(item.category);
    if (kind === undefined || !isKindEnabled(prefs, kind)) {
      continue;
    }
    notifications.push({
      id: `work:${item.id}`,
      kind,
      title: titleForKind(kind),
      body: `${item.repository}: ${item.title}`,
      ...(item.url.length > 0 ? { link: item.url } : {}),
      createdAt: now,
      read: false
    });
  }
  return { notifications, ids: items.map((item) => item.id) };
}

/** A stable key for a Service Bus entity's dead-letter count. */
export function deadLetterKey(namespace: string, topic: string | undefined, name: string): string {
  return `${namespace}/${topic ?? ""}/${name}`;
}

/** New dead-letter notifications: an entity whose dead-letter count rose above its previously
    seen value. Entities not present in `prev` are seeded silently (no fire on first sight), so
    a fresh start never spams. Returns notifications + the new per-entity counts. Counts start
    from `prev` so an entity transiently missing from one snapshot keeps its remembered count
    (and a genuine rise on its return is still detected) rather than being silently re-seeded. */
export function deadLetterNotifications(
  snapshot: ServiceBusSnapshot,
  prefs: NotificationPrefs,
  prev: Readonly<Record<string, number>>,
  now: string
): { notifications: AppNotification[]; counts: Record<string, number> } {
  const counts: Record<string, number> = { ...prev };
  const notifications: AppNotification[] = [];
  if (!snapshot.available) {
    return { notifications, counts: { ...prev } };
  }
  for (const ns of snapshot.namespaces) {
    for (const entity of ns.entities) {
      const key = deadLetterKey(entity.namespace, entity.topic, entity.name);
      counts[key] = entity.deadLetter;
      const known = Object.hasOwn(prev, key);
      const before = prev[key] ?? 0;
      if (isKindEnabled(prefs, "dead_letter") && known && entity.deadLetter > before) {
        const label = entity.topic === undefined ? entity.name : `${entity.topic}/${entity.name}`;
        notifications.push({
          id: `dl:${key}:${entity.deadLetter}`,
          kind: "dead_letter",
          title: titleForKind("dead_letter"),
          body: `${label} (${entity.namespace}): ${entity.deadLetter} dead-letter`,
          createdAt: now,
          read: false
        });
      }
    }
  }
  return { notifications, counts };
}

const EXPIRY_SEEN_KEY = "honeyhub.notificationExpirySeen.v1";

/** The persisted set of expiry keys already alerted on, so each expiring item alerts once across
    sessions (rather than every cockpit open). */
export function loadExpirySeen(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(EXPIRY_SEEN_KEY);
    if (raw === null || raw === undefined) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function saveExpirySeen(seen: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(EXPIRY_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Best-effort.
  }
}

/** A stable key for an expiring object. Includes `expires`, so renewing a secret (a new expiry)
    counts as a fresh item and can alert again. */
export function expiryKey(object: ExpiringObject): string {
  return `${object.subscriptionId}/${object.vault}/${object.kind}/${object.name}/${object.expires}`;
}

/**
 * New expiry notifications: objects whose expiry is at or within the operator's threshold (already
 * expired included), not already in `seen`, when the secret-expiring kind is enabled. Returns the
 * notifications to fire plus the FULL set of currently-in-window keys; the caller persists that as
 * the new `seen`, so a renewed object drops out and only genuinely new ones fire. An unavailable
 * scan leaves the prior `seen` untouched (no fire, no reset). `now` is an ISO timestamp.
 */
export function expiringNotifications(
  expiring: ExpiringObjects,
  prefs: NotificationPrefs,
  seen: ReadonlySet<string>,
  now: string
): { notifications: AppNotification[]; keys: string[] } {
  const nowMs = Date.parse(now);
  if (!expiring.available || Number.isNaN(nowMs)) {
    // Unavailable scan or an unparseable clock: change nothing, keep the prior alerted-set.
    return { notifications: [], keys: [...seen] };
  }
  const windowMs = clampExpiryDays(prefs.secretExpiryDays) * 24 * 60 * 60 * 1000;
  const keys: string[] = [];
  const notifications: AppNotification[] = [];
  for (const object of expiring.objects) {
    const at = parseInstantMs(object.expires);
    if (at === undefined || at > nowMs + windowMs) {
      continue; // no parseable expiry, or not yet within the window
    }
    const key = expiryKey(object);
    keys.push(key);
    if (seen.has(key) || !isKindEnabled(prefs, "secret_expiring")) {
      continue;
    }
    const expired = at <= nowMs;
    const when = new Date(at).toISOString().slice(0, 10);
    notifications.push({
      id: `kv-expiry:${key}`,
      kind: "secret_expiring",
      title: titleForKind("secret_expiring"),
      body: `${object.vault}: ${object.kind} “${object.name}” ${expired ? "expired" : "expires"} ${when}`,
      createdAt: now,
      read: false
    });
  }
  return { notifications, keys };
}

/** Build the chat-finished notification for a completed run. */
export function chatFinishedNotification(
  runId: string,
  detail: string,
  now: string
): AppNotification {
  return {
    id: `chat:${runId}`,
    kind: "chat_finished",
    title: titleForKind("chat_finished"),
    body: detail,
    createdAt: now,
    read: false
  };
}

/** Prepend new notifications to the feed, de-duping by id, capped. */
export function mergeFeed(
  feed: AppNotification[],
  incoming: AppNotification[]
): AppNotification[] {
  if (incoming.length === 0) {
    return feed;
  }
  const incomingIds = new Set(incoming.map((item) => item.id));
  const kept = feed.filter((item) => !incomingIds.has(item.id));
  return [...incoming, ...kept].slice(0, FEED_CAP);
}

export function unreadCount(feed: AppNotification[]): number {
  return feed.reduce((sum, item) => sum + (item.read ? 0 : 1), 0);
}
