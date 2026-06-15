import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enabledIds,
  getConnectorConfig,
  isConnectorConfigured,
  isConnectorEnabled,
  loadConnectorConfig,
  loadConnectorPrefs,
  saveConnectorConfig,
  saveConnectorPrefs,
  setConnectorConfig,
  setConnectorEnabled
} from "./connectors";

describe("connectors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables an available connector but refuses an unknown one", () => {
    const enabled = setConnectorEnabled({}, "github", true);
    expect(isConnectorEnabled(enabled, "github")).toBe(true);
    // Unknown id → unchanged (guard against enabling something not in the registry).
    expect(setConnectorEnabled({}, "nope", true)).toEqual({});
  });

  it("lists enabled ids by category", () => {
    const prefs = setConnectorEnabled({}, "github", true);
    expect(enabledIds(prefs, "work")).toEqual(["github"]);
    expect(enabledIds(prefs, "observability")).toEqual([]);
  });

  it("round-trips prefs and ignores non-true / garbled storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    });
    saveConnectorPrefs({ github: true });
    expect(loadConnectorPrefs()).toEqual({ github: true });

    // Only `true` values survive; everything else is dropped.
    store.set("honeyhub.connectors.v1", '{"github":true,"ado":false,"x":"yes"}');
    expect(loadConnectorPrefs()).toEqual({ github: true });

    store.set("honeyhub.connectors.v1", "not json");
    expect(loadConnectorPrefs()).toEqual({});
  });

  it("tracks per-connector config and 'configured' state (optional fields don't gate)", () => {
    // github needs no config → always considered configured.
    expect(isConnectorConfigured({}, "github")).toBe(true);
    // grafana needs only baseUrl (token is optional → anonymous Grafana works).
    expect(isConnectorConfigured({}, "grafana")).toBe(false);
    const grafana = setConnectorConfig({}, "grafana", { baseUrl: "https://g.example" });
    expect(isConnectorConfigured(grafana, "grafana")).toBe(true);
    expect(getConnectorConfig(grafana, "grafana").baseUrl).toBe("https://g.example");
    // sentry needs org + project + token (baseUrl optional → defaults to sentry.io).
    expect(isConnectorConfigured({}, "sentry")).toBe(false);
    const partial = setConnectorConfig({}, "sentry", { org: "hd", project: "hh" });
    expect(isConnectorConfigured(partial, "sentry")).toBe(false);
    const full = setConnectorConfig({}, "sentry", { org: "hd", project: "hh", token: "t" });
    expect(isConnectorConfigured(full, "sentry")).toBe(true);
  });

  it("round-trips connector config through storage, keeping only string values", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    });
    saveConnectorConfig({ grafana: { baseUrl: "https://g", token: "t" } });
    expect(loadConnectorConfig()).toEqual({ grafana: { baseUrl: "https://g", token: "t" } });

    store.set("honeyhub.connectorConfig.v1", '{"grafana":{"baseUrl":"https://g","n":5}}');
    expect(loadConnectorConfig()).toEqual({ grafana: { baseUrl: "https://g" } });
  });
});
