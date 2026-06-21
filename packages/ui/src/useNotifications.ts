import { useCallback, useEffect, useRef } from "react";
import { backendLabel } from "./backends";
import type { WireClient } from "./wire/client";
import { osNotify } from "./osNotify";
import {
  chatFinishedNotification,
  deadLetterNotifications,
  isKindEnabled,
  workNotifications,
  type AppNotification,
  type NotificationPrefs
} from "./notifications";

export interface UseNotificationsOptions {
  client: WireClient;
  prefs: NotificationPrefs;
  /** Enabled work connector ids (e.g. ["github","ado"]); empty disables work polling. */
  workSources: string[];
  /** Whether the Service Bus connector is enabled (gates dead-letter polling). */
  serviceBusEnabled: boolean;
  /** Session ids that count as chat threads (the full Chat page + the sidebar). */
  chatSessionIds: string[];
  /** Whether the user is actively looking at a chat thread (so a finish there is silent). */
  isThreadActive: (sessionId: string) => boolean;
  /** Sink for fired notifications (App merges them into the feed). */
  onNotifications: (items: AppNotification[]) => void;
}

/**
 * The notification engine. Subscribes to the bridge's run/work/Service Bus events, polls the
 * connectors in the background (so alerts fire regardless of the active tab), diffs against a
 * "seen" set, and fires both an OS toast (when desktop is enabled + permitted) and the in-app
 * feed. Detection logic is the pure helpers in `notifications.ts`; this is just the wiring.
 */
export function useNotifications(options: Readonly<UseNotificationsOptions>): void {
  const { client } = options;
  const prefsRef = useRef(options.prefs);
  prefsRef.current = options.prefs;
  const isThreadActiveRef = useRef(options.isThreadActive);
  isThreadActiveRef.current = options.isThreadActive;
  const onNotificationsRef = useRef(options.onNotifications);
  onNotificationsRef.current = options.onNotifications;
  const chatSessionsRef = useRef(options.chatSessionIds);
  chatSessionsRef.current = options.chatSessionIds;
  const workSourcesRef = useRef(options.workSources);
  workSourcesRef.current = options.workSources;
  const serviceBusEnabledRef = useRef(options.serviceBusEnabled);
  serviceBusEnabledRef.current = options.serviceBusEnabled;

  // Detection state (in-memory; re-seeded on reload, which keeps a fresh start from spamming).
  const seenWork = useRef<Set<string>>(new Set());
  // Sources whose backlog has been seeded silently — tracked per source (not a single flag) so
  // a connector that is unavailable on the first snapshot and only becomes readable later still
  // seeds rather than spamming its pre-existing items.
  const seededSources = useRef<Set<string>>(new Set());
  const deadLetterCounts = useRef<Record<string, number>>({});
  const firedChatRuns = useRef<Set<string>>(new Set());

  const fire = useCallback((items: AppNotification[]) => {
    if (items.length === 0) {
      return;
    }
    if (prefsRef.current.desktop) {
      for (const item of items) {
        osNotify(item.title, item.body, item.link);
      }
    }
    onNotificationsRef.current(items);
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "status") {
        if (
          payload.status.state === "completed" &&
          chatSessionsRef.current.includes(event.sessionId) &&
          !firedChatRuns.current.has(event.runId) &&
          isKindEnabled(prefsRef.current, "chat_finished") &&
          !isThreadActiveRef.current(event.sessionId)
        ) {
          firedChatRuns.current.add(event.runId);
          fire([
            chatFinishedNotification(
              event.runId,
              `${backendLabel(payload.status.backend)} finished responding.`,
              new Date().toISOString()
            )
          ]);
        }
      } else if (payload.kind === "work_snapshot") {
        const snapshot = payload.snapshot;
        // Seed any source seen available for the first time so its pre-existing items don't
        // fire as "new" (covers a connector that wasn't signed in on the first snapshot).
        for (const source of snapshot.sources) {
          if (source.available && !seededSources.current.has(source.source)) {
            for (const item of source.items ?? []) {
              seenWork.current.add(item.id);
            }
            seededSources.current.add(source.source);
          }
        }
        const { notifications, ids } = workNotifications(
          snapshot,
          prefsRef.current,
          seenWork.current,
          new Date().toISOString()
        );
        // Accumulate (rather than reset to the current ids) so a fired item — or one preserved
        // across a transient source outage — does not re-fire on the next poll.
        for (const id of ids) {
          seenWork.current.add(id);
        }
        fire(notifications);
      } else if (payload.kind === "service_bus_snapshot") {
        const { notifications, counts } = deadLetterNotifications(
          payload.snapshot,
          prefsRef.current,
          deadLetterCounts.current,
          new Date().toISOString()
        );
        deadLetterCounts.current = counts;
        fire(notifications);
      }
    });
    return unsubscribe;
  }, [client, fire]);

  // Background poll so work + dead-letter alerts fire regardless of which tab is open. Keyed by
  // the joined source list so it re-arms when the enabled connectors change.
  const workKey = options.workSources.join(",");
  useEffect(() => {
    const poll = (): void => {
      if (workSourcesRef.current.length > 0) {
        client.listWork(workSourcesRef.current).catch(() => undefined);
      }
      if (serviceBusEnabledRef.current) {
        client.listServiceBus().catch(() => undefined);
      }
    };
    poll();
    const timer = setInterval(poll, 60_000);
    return () => clearInterval(timer);
  }, [client, workKey, options.serviceBusEnabled]);
}
