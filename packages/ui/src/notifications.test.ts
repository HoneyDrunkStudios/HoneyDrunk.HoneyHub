import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExpiringObjects,
  ServiceBusSnapshot,
  WorkSnapshot
} from "@honeydrunk/honeyhub-types";
import {
  chatFinishedNotification,
  clampExpiryDays,
  collectWorkItems,
  deadLetterNotifications,
  defaultNotificationPrefs,
  expiringNotifications,
  expiryKey,
  kindForCategory,
  loadExpirySeen,
  mergeFeed,
  saveExpirySeen,
  unreadCount,
  workNotifications,
  type AppNotification
} from "./notifications";

const NOW = "2026-06-21T12:00:00Z";
const inDays = (days: number): string => new Date(Date.parse(NOW) + days * 86_400_000).toISOString();

function expiringSnap(
  objects: { name: string; expires: string; kind?: "secret" | "key" | "certificate" }[]
): ExpiringObjects {
  return {
    available: true,
    objects: objects.map((object) => ({
      vault: "kv-dev",
      subscriptionId: "sub-1",
      kind: object.kind ?? "secret",
      name: object.name,
      expires: object.expires
    }))
  };
}

function workSnap(items: { id: string; category: string; source?: string }[]): WorkSnapshot {
  return {
    sources: [
      {
        source: "github",
        available: true,
        items: items.map((i) => ({
          id: i.id,
          source: i.source ?? "github",
          kind: "issue",
          category: i.category,
          title: `title ${i.id}`,
          repository: "acme/widgets",
          url: `https://x/${i.id}`,
          state: "open"
        }))
      }
    ]
  };
}

describe("notifications model", () => {
  it("maps categories to kinds (and ignores Authored)", () => {
    expect(kindForCategory("Assigned")).toBe("work_assigned");
    expect(kindForCategory("Mentioned")).toBe("work_mentioned");
    expect(kindForCategory("Review requested")).toBe("pr_review");
    expect(kindForCategory("Authored")).toBeUndefined();
  });

  it("fires work notifications only for new, enabled items", () => {
    const snap = workSnap([
      { id: "a", category: "Assigned" },
      { id: "m", category: "Mentioned" },
      { id: "r", category: "Review requested" },
      { id: "w", category: "Authored" }
    ]);
    const { notifications, ids } = workNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
    // Authored doesn't notify; the other three do.
    expect(notifications.map((n) => n.kind).sort()).toEqual([
      "pr_review",
      "work_assigned",
      "work_mentioned"
    ]);
    expect(ids.sort()).toEqual(["a", "m", "r", "w"]);

    // Already-seen items don't re-fire.
    const again = workNotifications(snap, defaultNotificationPrefs, new Set(ids), NOW);
    expect(again.notifications).toHaveLength(0);
  });

  it("respects per-type toggles", () => {
    const snap = workSnap([{ id: "a", category: "Assigned" }]);
    const prefs = { ...defaultNotificationPrefs, workAssigned: false };
    expect(workNotifications(snap, prefs, new Set(), NOW).notifications).toHaveLength(0);
  });

  it("is source-agnostic (ADO items notify too)", () => {
    const snap = workSnap([{ id: "ado-1", category: "Assigned", source: "ado" }]);
    const { notifications } = workNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("work_assigned");
  });

  it("fires a dead-letter notification only when the count rises above a seen value", () => {
    const snap = (dl: number): ServiceBusSnapshot => ({
      available: true,
      namespaces: [
        {
          name: "ns",
          resourceGroup: "rg",
          entities: [
            {
              name: "orders",
              kind: "queue",
              namespace: "ns.servicebus.windows.net",
              status: "Active",
              active: 0,
              deadLetter: dl,
              scheduled: 0
            }
          ]
        }
      ]
    });
    // First sight seeds silently (entity not in prev).
    const first = deadLetterNotifications(snap(3), defaultNotificationPrefs, {}, NOW);
    expect(first.notifications).toHaveLength(0);
    // A rise above the seeded count fires.
    const rise = deadLetterNotifications(snap(5), defaultNotificationPrefs, first.counts, NOW);
    expect(rise.notifications).toHaveLength(1);
    expect(rise.notifications[0]?.kind).toBe("dead_letter");
    // No change → nothing.
    const same = deadLetterNotifications(snap(5), defaultNotificationPrefs, rise.counts, NOW);
    expect(same.notifications).toHaveLength(0);
  });

  it("preserves a remembered count when an entity is transiently absent from a snapshot", () => {
    const snap = (dl: number): ServiceBusSnapshot => ({
      available: true,
      namespaces: [
        {
          name: "ns",
          resourceGroup: "rg",
          entities: [
            {
              name: "orders",
              kind: "queue",
              namespace: "ns.servicebus.windows.net",
              status: "Active",
              active: 0,
              deadLetter: dl,
              scheduled: 0
            }
          ]
        }
      ]
    });
    const empty: ServiceBusSnapshot = {
      available: true,
      namespaces: [{ name: "ns", resourceGroup: "rg", entities: [] }]
    };
    const seeded = deadLetterNotifications(snap(5), defaultNotificationPrefs, {}, NOW);
    // A snapshot that omits the entity must not drop its remembered count...
    const gap = deadLetterNotifications(empty, defaultNotificationPrefs, seeded.counts, NOW);
    expect(gap.notifications).toHaveLength(0);
    // ...so the entity returning at the same count is not mistaken for a fresh rise.
    const back = deadLetterNotifications(snap(5), defaultNotificationPrefs, gap.counts, NOW);
    expect(back.notifications).toHaveLength(0);
    // A genuine rise after the gap still fires.
    const rise = deadLetterNotifications(snap(8), defaultNotificationPrefs, back.counts, NOW);
    expect(rise.notifications).toHaveLength(1);
  });

  it("maps review-requested to pr_review and unknown categories to undefined", () => {
    expect(kindForCategory("Review requested")).toBe("pr_review");
    expect(kindForCategory("Authored")).toBeUndefined();
  });

  it("collects work items only from available sources", () => {
    const snapshot = {
      sources: [
        ...workSnap([{ id: "a", category: "assigned" }]).sources,
        { source: "ado", available: false, error: "not signed in" }
      ]
    };
    expect(collectWorkItems(snapshot).map((i) => i.id)).toEqual(["a"]);
  });

  it("omits the link when a work item has no url", () => {
    const snap = workSnap([{ id: "x", category: "assigned" }]);
    snap.sources[0]!.items![0]!.url = "";
    const { notifications } = workNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.link).toBeUndefined();
  });

  it("builds a chat-finished notification and treats empty incoming as a no-op merge", () => {
    const note = chatFinishedNotification("run-1", "Claude finished responding.", NOW);
    expect(note.kind).toBe("chat_finished");
    expect(note.id).toBe("chat:run-1");
    const feed: AppNotification[] = [note];
    expect(mergeFeed(feed, [])).toBe(feed);
  });

  it("merges the feed by id (newest first), and counts unread", () => {
    const a: AppNotification = { id: "1", kind: "chat_finished", title: "t", body: "b", createdAt: NOW, read: false };
    const b: AppNotification = { id: "2", kind: "work_assigned", title: "t", body: "b", createdAt: NOW, read: true };
    const feed = mergeFeed([b], [a]);
    expect(feed.map((n) => n.id)).toEqual(["1", "2"]);
    expect(unreadCount(feed)).toBe(1);
    // Re-merging the same id replaces rather than duplicates.
    expect(mergeFeed(feed, [a]).filter((n) => n.id === "1")).toHaveLength(1);
  });

  describe("expiry notifications", () => {
    it("fires for items within the window (and already expired), not for ones beyond it", () => {
      const snap = expiringSnap([
        { name: "soon", expires: inDays(10) },
        { name: "expired", expires: inDays(-5) },
        { name: "far", expires: inDays(100) }
      ]);
      const { notifications, keys } = expiringNotifications(
        snap,
        defaultNotificationPrefs,
        new Set(),
        NOW
      );
      expect(notifications).toHaveLength(2);
      expect(notifications.every((n) => n.kind === "secret_expiring")).toBe(true);
      expect(notifications.find((n) => n.body.includes("expired"))).toBeTruthy();
      // `keys` is the full in-window set (soon + expired); `far` is excluded.
      expect(keys).toHaveLength(2);
    });

    it("uses an opaque key + body that never carry the object name", () => {
      const obj = {
        vault: "kv-prod",
        subscriptionId: "sub-1",
        kind: "secret" as const,
        name: "stripe-prod-signing-key",
        expires: inDays(5)
      };
      const key = expiryKey(obj);
      expect(key).not.toContain("stripe-prod-signing-key");
      // Stable, and a renewed expiry hashes differently (so it can alert again).
      expect(expiryKey(obj)).toBe(key);
      expect(expiryKey({ ...obj, expires: inDays(400) })).not.toBe(key);

      const { notifications } = expiringNotifications(
        { available: true, objects: [obj] },
        defaultNotificationPrefs,
        new Set(),
        NOW
      );
      // The persisted feed entry (id + body) carries the vault + kind + date, never the name.
      expect(notifications[0]?.id).not.toContain("stripe-prod-signing-key");
      expect(notifications[0]?.body).not.toContain("stripe-prod-signing-key");
      expect(notifications[0]?.body).toContain("kv-prod");
    });

    it("does not re-fire an item already in seen", () => {
      const snap = expiringSnap([{ name: "soon", expires: inDays(10) }]);
      const first = expiringNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
      const again = expiringNotifications(snap, defaultNotificationPrefs, new Set(first.keys), NOW);
      expect(again.notifications).toHaveLength(0);
    });

    it("respects the secret-expiring toggle and the day threshold", () => {
      const snap = expiringSnap([{ name: "soon", expires: inDays(10) }]);
      // Toggle off → nothing fires (but keys still tracked so it won't spam when re-enabled).
      const off = { ...defaultNotificationPrefs, secretExpiring: false };
      expect(expiringNotifications(snap, off, new Set(), NOW).notifications).toHaveLength(0);
      // A 5-day window excludes an item 10 days out.
      const tight = { ...defaultNotificationPrefs, secretExpiryDays: 5 };
      expect(expiringNotifications(snap, tight, new Set(), NOW).notifications).toHaveLength(0);
    });

    it("warns once when the scan is truncated (incomplete coverage)", () => {
      const snap: ExpiringObjects = { available: true, truncated: true, objects: [] };
      const first = expiringNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
      expect(first.notifications).toHaveLength(1);
      expect(first.notifications[0]?.body).toMatch(/more Key Vaults/i);
      expect(first.keys).toContain("kv-expiry-truncated");
      // Deduped: once the sentinel is in seen, it does not re-warn.
      const again = expiringNotifications(snap, defaultNotificationPrefs, new Set(first.keys), NOW);
      expect(again.notifications).toHaveLength(0);
    });

    it("warns once when some vaults could not be read (partial coverage)", () => {
      const snap: ExpiringObjects = { available: true, unreadable: ["kv-locked"], objects: [] };
      const first = expiringNotifications(snap, defaultNotificationPrefs, new Set(), NOW);
      expect(first.notifications).toHaveLength(1);
      expect(first.notifications[0]?.body).toMatch(/could not be read/i);
      expect(first.keys).toContain("kv-expiry-partial");
      const again = expiringNotifications(snap, defaultNotificationPrefs, new Set(first.keys), NOW);
      expect(again.notifications).toHaveLength(0);
    });

    it("leaves the prior seen untouched on an unavailable scan or an unparseable clock", () => {
      const seen = new Set(["k1", "k2"]);
      const unavailable = expiringNotifications(
        { available: false, objects: [] },
        defaultNotificationPrefs,
        seen,
        NOW
      );
      expect(unavailable.notifications).toHaveLength(0);
      expect(unavailable.keys.sort()).toEqual(["k1", "k2"]);

      // A bad `now` changes nothing rather than mis-firing.
      const badNow = expiringNotifications(
        expiringSnap([{ name: "soon", expires: inDays(10) }]),
        defaultNotificationPrefs,
        seen,
        "not a date"
      );
      expect(badNow.notifications).toHaveLength(0);
      expect(badNow.keys.sort()).toEqual(["k1", "k2"]);
    });
  });

  describe("expiry settings + seen persistence", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("clamps the expiry-days setting into range, defaulting bad input", () => {
      expect(clampExpiryDays(0)).toBe(1);
      expect(clampExpiryDays(10_000)).toBe(365);
      expect(clampExpiryDays(7.6)).toBe(8);
      expect(clampExpiryDays(Number.NaN)).toBe(defaultNotificationPrefs.secretExpiryDays);
    });

    it("round-trips the seen set through localStorage, tolerating bad data", () => {
      const store: Record<string, string> = {};
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0
      });
      expect(loadExpirySeen().size).toBe(0);
      saveExpirySeen(new Set(["a", "b"]));
      expect([...loadExpirySeen()].sort()).toEqual(["a", "b"]);
      store["honeyhub.notificationExpirySeen.v1"] = "not json";
      expect(loadExpirySeen().size).toBe(0);
    });
  });
});
