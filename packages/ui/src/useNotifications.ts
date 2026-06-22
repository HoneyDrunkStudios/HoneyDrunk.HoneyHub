import { useCallback, useEffect, useRef } from "react";
import { backendLabel } from "./backends";
import type {
  BridgeEvent,
  BridgeStatusEvent,
  ExpiringObjects,
  ServiceBusSnapshot,
  WorkSnapshot
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "./wire/client";
import { osNotify } from "./osNotify";
import { sameSubscriptions } from "./routes/observe/keyVaultModel";
import {
  chatFinishedNotification,
  coverageWarnings,
  deadLetterNotifications,
  expiringNotifications,
  isKindEnabled,
  loadExpirySeen,
  noCoverageWarned,
  saveExpirySeen,
  workNotifications,
  type AppNotification,
  type CoverageWarned,
  type NotificationPrefs
} from "./notifications";

export interface UseNotificationsOptions {
  client: WireClient;
  prefs: NotificationPrefs;
  /** Enabled work connector ids (e.g. ["github","ado"]); empty disables work polling. */
  workSources: string[];
  /** Whether the Service Bus connector is enabled (gates dead-letter polling). */
  serviceBusEnabled: boolean;
  /** Whether the Key Vault connector is enabled (gates the background expiry scan). */
  keyVaultEnabled: boolean;
  /** The selected Key Vault subscription ids to scan for expiring objects. */
  keyVaultSubscriptions: string[];
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
  const keyVaultEnabledRef = useRef(options.keyVaultEnabled);
  keyVaultEnabledRef.current = options.keyVaultEnabled;
  const keyVaultSubscriptionsRef = useRef(options.keyVaultSubscriptions);
  keyVaultSubscriptionsRef.current = options.keyVaultSubscriptions;

  // Detection state (in-memory; re-seeded on reload, which keeps a fresh start from spamming).
  const seenWork = useRef<Set<string>>(new Set());
  // Sources whose backlog has been seeded silently — tracked per source (not a single flag) so
  // a connector that is unavailable on the first snapshot and only becomes readable later still
  // seeds rather than spamming its pre-existing items.
  const seededSources = useRef<Set<string>>(new Set());
  const deadLetterCounts = useRef<Record<string, number>>({});
  const firedChatRuns = useRef<Set<string>>(new Set());
  // Persisted across sessions so each expiring Key Vault item alerts once, not on every open.
  const expirySeen = useRef<Set<string>>(loadExpirySeen());
  // Session-only: last coverage-warning state, so a warning re-fires on a complete -> incomplete
  // transition rather than being suppressed forever by the persisted object-seen set.
  const coverageWarned = useRef<CoverageWarned>(noCoverageWarned);

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
    const handleStatus = (event: BridgeEvent, status: BridgeStatusEvent): void => {
      if (
        status.state === "completed" &&
        chatSessionsRef.current.includes(event.sessionId) &&
        !firedChatRuns.current.has(event.runId) &&
        isKindEnabled(prefsRef.current, "chat_finished") &&
        !isThreadActiveRef.current(event.sessionId)
      ) {
        firedChatRuns.current.add(event.runId);
        fire([
          chatFinishedNotification(
            event.runId,
            `${backendLabel(status.backend)} finished responding.`,
            new Date().toISOString()
          )
        ]);
      }
    };

    const handleWorkSnapshot = (snapshot: WorkSnapshot): void => {
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
      // Accumulate (rather than reset to the current ids) so a fired item, or one preserved
      // across a transient source outage, does not re-fire on the next poll.
      for (const id of ids) {
        seenWork.current.add(id);
      }
      fire(notifications);
    };

    const handleServiceBusSnapshot = (snapshot: ServiceBusSnapshot): void => {
      const { notifications, counts } = deadLetterNotifications(
        snapshot,
        prefsRef.current,
        deadLetterCounts.current,
        new Date().toISOString()
      );
      deadLetterCounts.current = counts;
      fire(notifications);
    };

    const handleKeyVaultExpiry = (expiring: ExpiringObjects): void => {
      // Discard the whole result (objects AND coverage metadata) if the subscriptions it covered no
      // longer match the current selection: a slow scan can resolve after the operator re-selects,
      // and a stale result describes a prior view. We return WITHOUT tracking its keys, because they
      // belong to a different selection and tracking them would suppress a valid alert if that
      // selection returns.
      if (!sameSubscriptions(expiring.subscriptionIds ?? [], keyVaultSubscriptionsRef.current)) {
        return;
      }
      // If the CONNECTOR was switched off before this (slow) scan resolved, discard the stale result
      // entirely WITHOUT consuming any seen / coverage state: the connector is the data source, and
      // re-enabling it should give a fresh first-alert rather than find these objects already marked
      // seen. This is distinct from merely muting the alert toggle (suppress-but-track below): the
      // toggle keeps the connector scanning, so tracking is correct there; a disabled connector is
      // not scanning at all, so a late result is genuinely stale.
      if (!keyVaultEnabledRef.current) {
        return;
      }
      const now = new Date().toISOString();

      const { notifications, keys } = expiringNotifications(
        expiring,
        prefsRef.current,
        expirySeen.current,
        now
      );
      // Always TRACK the in-window keys (suppress-but-track, like the dead-letter counts): even when
      // the alert TOGGLE is off, recording them means re-enabling does not backlog objects that came
      // into window while it was off. Union (never replace) so a PARTIAL scan that could not read
      // some vaults does not forget their previously-alerted objects and re-fire on access return.
      // Firing itself is gated on the toggle inside expiringNotifications/coverageWarnings.
      for (const key of keys) {
        expirySeen.current.add(key);
      }
      saveExpirySeen(expirySeen.current);
      fire(notifications);

      // Coverage warnings are separate + transition-based (session memory), so they re-warn if
      // coverage degrades again rather than being suppressed forever.
      const coverage = coverageWarnings(expiring, prefsRef.current, coverageWarned.current, now);
      coverageWarned.current = coverage.warned;
      fire(coverage.notifications);
    };

    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "status") {
        handleStatus(event, payload.status);
      } else if (payload.kind === "work_snapshot") {
        handleWorkSnapshot(payload.snapshot);
      } else if (payload.kind === "service_bus_snapshot") {
        handleServiceBusSnapshot(payload.snapshot);
      } else if (payload.kind === "key_vault_expiry") {
        handleKeyVaultExpiry(payload.expiring);
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

  // Background Key Vault expiry scan on a long cadence: expiry changes slowly and the scan is a
  // heavy `az` fan-out (every vault's objects), so it runs far less often than the 60s work poll.
  // Runs whenever the CONNECTOR is on (not gated on the alert toggle), so the seen-set keeps
  // tracking objects that come into window while the alert is muted; the handler suppresses the
  // toast but still records the keys, so re-enabling does not backlog. The dep sorts the
  // subscription ids so merely reordering the selection does not re-arm the timer; it re-arms on a
  // real change or the connector toggle.
  const expiryActive = options.keyVaultEnabled;
  const expiryKeyDep = expiryActive ? [...options.keyVaultSubscriptions].sort().join(",") : "";
  useEffect(() => {
    const scan = (): void => {
      if (keyVaultEnabledRef.current && keyVaultSubscriptionsRef.current.length > 0) {
        client.scanKeyVaultExpiry(keyVaultSubscriptionsRef.current).catch(() => undefined);
      }
    };
    scan();
    const timer = setInterval(scan, 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [client, expiryKeyDep]);
}
