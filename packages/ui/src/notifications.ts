import type { ServiceBusSnapshot, WorkItem, WorkSnapshot } from "@honeydrunk/honeyhub-types";

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
  | "dead_letter";

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
}

export const defaultNotificationPrefs: NotificationPrefs = {
  desktop: true,
  chatFinished: true,
  workAssigned: true,
  workMentioned: true,
  prReview: true,
  deadLetter: true
};

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
      typeof record[key] === "boolean" ? (record[key] as boolean) : defaultNotificationPrefs[key];
    return {
      desktop: bool("desktop"),
      chatFinished: bool("chatFinished"),
      workAssigned: bool("workAssigned"),
      workMentioned: bool("workMentioned"),
      prReview: bool("prReview"),
      deadLetter: bool("deadLetter")
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
      const known = Object.prototype.hasOwnProperty.call(prev, key);
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
