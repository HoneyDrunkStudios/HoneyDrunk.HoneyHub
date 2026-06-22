import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureSubscription, KeyVault } from "@honeydrunk/honeyhub-types";
import {
  filterVaults,
  initialSelection,
  loadSelectedSubscriptions,
  saveSelectedSubscriptions,
  subscriptionKey
} from "./keyVaultModel";

const subs: AzureSubscription[] = [
  { id: "sub-dev", name: "Dev", isDefault: false },
  { id: "sub-prod", name: "Prod", isDefault: true }
];

const vaults: KeyVault[] = [
  { name: "kv-app", resourceGroup: "rg-app", location: "eastus", subscriptionId: "sub-dev" },
  { name: "kv-data", resourceGroup: "rg-core", subscriptionId: "sub-prod" }
];

describe("keyVaultModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("initialSelection", () => {
    it("picks the default subscription on a first run (nothing saved)", () => {
      expect(initialSelection(subs, [])).toEqual(["sub-prod"]);
    });

    it("falls back to the first subscription when none is default", () => {
      const noDefault = subs.map((sub) => ({ ...sub, isDefault: false }));
      expect(initialSelection(noDefault, [])).toEqual(["sub-dev"]);
    });

    it("keeps the saved selection, dropping ids that no longer exist", () => {
      expect(initialSelection(subs, ["sub-dev", "sub-gone"])).toEqual(["sub-dev"]);
    });

    it("ignores a stale saved selection that matches nothing", () => {
      // Every saved id is gone → fall back to the default subscription.
      expect(initialSelection(subs, ["sub-gone"])).toEqual(["sub-prod"]);
    });

    it("returns empty when there are no subscriptions", () => {
      expect(initialSelection([], ["sub-dev"])).toEqual([]);
    });
  });

  describe("subscriptionKey", () => {
    it("is order-insensitive so a reordered selection matches its response", () => {
      expect(subscriptionKey(["b", "a"])).toBe(subscriptionKey(["a", "b"]));
    });

    it("distinguishes different selections (stale response detection)", () => {
      expect(subscriptionKey(["a"])).not.toBe(subscriptionKey(["a", "b"]));
      expect(subscriptionKey([])).toBe("");
    });
  });

  describe("filterVaults", () => {
    it("returns all vaults for an empty/whitespace query", () => {
      expect(filterVaults(vaults, "")).toHaveLength(2);
      expect(filterVaults(vaults, "   ")).toHaveLength(2);
    });

    it("matches on name, resource group, or location, case-insensitively", () => {
      expect(filterVaults(vaults, "APP").map((v) => v.name)).toEqual(["kv-app"]);
      expect(filterVaults(vaults, "rg-core").map((v) => v.name)).toEqual(["kv-data"]);
      expect(filterVaults(vaults, "eastus").map((v) => v.name)).toEqual(["kv-app"]);
      expect(filterVaults(vaults, "nope")).toHaveLength(0);
    });
  });

  describe("selection persistence", () => {
    it("round-trips through localStorage and tolerates bad/absent data", () => {
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

      expect(loadSelectedSubscriptions()).toEqual([]);
      saveSelectedSubscriptions(["sub-dev", "sub-prod"]);
      expect(loadSelectedSubscriptions()).toEqual(["sub-dev", "sub-prod"]);

      // Non-array / non-string entries are rejected, not thrown on.
      store["honeyhub.keyvault.subscriptions.v1"] = '{"not":"an array"}';
      expect(loadSelectedSubscriptions()).toEqual([]);
      store["honeyhub.keyvault.subscriptions.v1"] = '["ok", 7, null]';
      expect(loadSelectedSubscriptions()).toEqual(["ok"]);
    });
  });
});
