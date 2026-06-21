import { describe, expect, it } from "vitest";
import type { ServiceBusSnapshot, WorkSnapshot } from "@honeydrunk/honeyhub-types";
import {
  deadLetterNotifications,
  defaultNotificationPrefs,
  kindForCategory,
  mergeFeed,
  unreadCount,
  workNotifications,
  type AppNotification
} from "./notifications";

const NOW = "2026-06-21T12:00:00Z";

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

  it("merges the feed by id (newest first), and counts unread", () => {
    const a: AppNotification = { id: "1", kind: "chat_finished", title: "t", body: "b", createdAt: NOW, read: false };
    const b: AppNotification = { id: "2", kind: "work_assigned", title: "t", body: "b", createdAt: NOW, read: true };
    const feed = mergeFeed([b], [a]);
    expect(feed.map((n) => n.id)).toEqual(["1", "2"]);
    expect(unreadCount(feed)).toBe(1);
    // Re-merging the same id replaces rather than duplicates.
    expect(mergeFeed(feed, [a]).filter((n) => n.id === "1")).toHaveLength(1);
  });
});
