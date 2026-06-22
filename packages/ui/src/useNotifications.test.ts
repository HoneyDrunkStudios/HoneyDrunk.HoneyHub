import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  defaultNotificationPrefs,
  loadExpirySeen,
  type AppNotification
} from "./notifications";
import { useNotifications, type UseNotificationsOptions } from "./useNotifications";
import { MOCK_SUBSCRIPTION_DEV, MockWireClient } from "./wire/mockClient";

// Hook-level coverage for the suppress-but-track contract of the background Key Vault expiry scan
// (the pure detection is covered in notifications.test.ts; this proves the wiring). The mock's dev
// subscription scripts objects already past their expiry (so they are in-window today).

describe("useNotifications: Key Vault expiry wiring", () => {
  // jsdom here has no localStorage; stub an in-memory one so the persisted seen-set round-trips
  // (and survives across the two render phases within a test).
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      key: () => null,
      length: 0
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function options(
    client: MockWireClient,
    fired: AppNotification[],
    secretExpiring: boolean,
    keyVaultEnabled = true
  ): UseNotificationsOptions {
    return {
      client,
      // desktop off so the test never touches the OS Notification API.
      prefs: { ...defaultNotificationPrefs, desktop: false, secretExpiring },
      workSources: [],
      serviceBusEnabled: false,
      keyVaultEnabled,
      keyVaultSubscriptions: [MOCK_SUBSCRIPTION_DEV],
      chatSessionIds: [],
      isThreadActive: () => false,
      onNotifications: (items) => fired.push(...items)
    };
  }

  const expiryAlerts = (fired: AppNotification[]): AppNotification[] =>
    fired.filter((n) => n.kind === "secret_expiring");

  it("scans + tracks keys while the alert is disabled, then does not backlog on re-enable", () => {
    // Phase 1: connector ON, alert OFF. The scan must still run and persist the in-window keys
    // (a non-empty seen-set proves the scan ran), but must not fire (suppress-but-track, like the
    // dead-letter counts).
    const client = new MockWireClient();
    const firedDisabled: AppNotification[] = [];
    const disabled = renderHook(() => useNotifications(options(client, firedDisabled, false)));

    expect(expiryAlerts(firedDisabled)).toHaveLength(0);
    expect(loadExpirySeen().size).toBeGreaterThan(0);
    disabled.unmount();

    // Phase 2: a fresh mount with the alert ON and the SAME persisted seen-set. The scan fires no
    // backlog, because the objects that came into window while disabled were already tracked.
    const client2 = new MockWireClient();
    const firedEnabled: AppNotification[] = [];
    renderHook(() => useNotifications(options(client2, firedEnabled, true)));

    expect(expiryAlerts(firedEnabled)).toHaveLength(0);
  });

  it("discards a stale result that arrives after the connector is disabled, without consuming seen", async () => {
    // The connector is OFF (so the background poll is not running); a slow in-flight scan resolves
    // anyway. The result must be dropped whole, leaving the seen-set untouched, so re-enabling the
    // connector gives a fresh first-alert instead of finding these objects already "seen".
    const client = new MockWireClient();
    const fired: AppNotification[] = [];
    renderHook(() => useNotifications(options(client, fired, true, false)));

    await act(async () => {
      await client.scanKeyVaultExpiry([MOCK_SUBSCRIPTION_DEV]);
    });

    expect(loadExpirySeen().size).toBe(0);
    expect(expiryAlerts(fired)).toHaveLength(0);
  });

  it("fires once on a first enabled scan when nothing was tracked yet", () => {
    // Sanity: with an empty seen-set and the alert on, the scripted in-window objects do alert,
    // so the "no backlog" assertion above is meaningful (it is not just always zero).
    const client = new MockWireClient();
    const fired: AppNotification[] = [];
    renderHook(() => useNotifications(options(client, fired, true)));

    expect(expiryAlerts(fired).length).toBeGreaterThan(0);
  });
});
