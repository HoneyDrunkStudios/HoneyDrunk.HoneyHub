// Pure helpers for the Key Vault observability panel: which subscriptions the user has picked
// (persisted locally, like the connector prefs) and name/group/location filtering of the vault
// list. Kept out of the component so they're unit-testable.

import type { AzureSubscription, KeyVault } from "@honeydrunk/honeyhub-types";

const SUBS_STORAGE_KEY = "honeyhub.keyvault.subscriptions.v1";

/** The locally-remembered selected subscription ids (the ones whose vaults we list), or
    `undefined` when nothing has been saved yet. `undefined` (no preference) is kept distinct from
    `[]` (the user deliberately selected zero subscriptions) so a reload honors an intentional
    empty selection instead of snapping back to the default. */
export function loadSelectedSubscriptions(): string[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SUBS_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return undefined;
  }
}

export function saveSelectedSubscriptions(ids: string[]): void {
  try {
    globalThis.localStorage?.setItem(SUBS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable; keep the in-memory selection for this session only.
  }
}

/**
 * The subscriptions to pre-select once the list lands: the saved selection (kept only for
 * subscriptions that still exist), or (on a first run with nothing saved) the CLI's default
 * subscription, falling back to the first one. Empty in, empty out.
 */
export function initialSelection(
  subscriptions: AzureSubscription[],
  saved: string[] | undefined
): string[] {
  if (subscriptions.length === 0) {
    return [];
  }
  if (saved !== undefined) {
    // A saved preference is honored, including a deliberate empty selection. Drop ids that no
    // longer exist; only if a non-empty saved selection has gone entirely stale do we fall
    // through to the default (rather than showing nothing for a vanished selection).
    if (saved.length === 0) {
      return [];
    }
    const existing = new Set(subscriptions.map((subscription) => subscription.id));
    const remembered = saved.filter((id) => existing.has(id));
    if (remembered.length > 0) {
      return remembered;
    }
  }
  const fallback = subscriptions.find((subscription) => subscription.isDefault) ?? subscriptions[0];
  // `fallback` is always defined here (we returned early on an empty list); the guard keeps the
  // checker happy under noUncheckedIndexedAccess.
  return fallback === undefined ? [] : [fallback.id];
}

/** A selection-independent key for a set of subscription ids (order-insensitive), used to match
    a `key_vaults` response against the current selection so a stale/out-of-order response for a
    previous selection is ignored. */
export function subscriptionKey(ids: readonly string[]): string {
  return [...ids].sort((a, b) => a.localeCompare(b)).join(",");
}

/** Filter vaults by a case-insensitive match on name, resource group, or location. */
export function filterVaults(vaults: KeyVault[], query: string): KeyVault[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return vaults;
  }
  return vaults.filter((vault) =>
    [vault.name, vault.resourceGroup, vault.location ?? ""].some((field) =>
      field.toLowerCase().includes(needle)
    )
  );
}
