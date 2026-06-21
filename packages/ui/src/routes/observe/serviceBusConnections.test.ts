import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionAuth,
  connectionFromDraft,
  loadConnections,
  namespaceFromConnectionString,
  removeConnection,
  upsertConnection,
  type ServiceBusConnection
} from "./serviceBusConnections";

// The test environment's localStorage is read-only (setItem is not a function), so stub a
// fresh in-memory Storage per test to exercise the save/load round-trip properly.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serviceBusConnections", () => {
  it("derives a namespace from a connection string", () => {
    const cs =
      "Endpoint=sb://hd-bus-dev.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=abc=";
    expect(namespaceFromConnectionString(cs)).toBe("hd-bus-dev.servicebus.windows.net");
    expect(namespaceFromConnectionString("garbage")).toBe("");
  });

  it("builds a connection from a draft, deriving namespace from the connection string", () => {
    const cs = "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKey=k=";
    const conn = connectionFromDraft({ label: "Dev", namespace: "", connectionString: cs }, "id-1");
    expect(conn.namespace).toBe("ns.servicebus.windows.net");
    expect(conn.connectionString).toBe(cs);
    expect(conn.label).toBe("Dev");
  });

  it("requires a label and a namespace-or-connection-string", () => {
    expect(() => connectionFromDraft({ label: " ", namespace: "ns" }, "x")).toThrow(/name/);
    expect(() => connectionFromDraft({ label: "L", namespace: "" }, "x")).toThrow(/namespace/);
  });

  it("an AAD connection has no connection string", () => {
    const conn = connectionFromDraft({ label: "Prod", namespace: "p.servicebus.windows.net" }, "id-2");
    expect(conn.connectionString).toBeUndefined();
    expect(connectionAuth(conn)).toEqual({ namespace: "p.servicebus.windows.net" });
  });

  it("upserts and removes connections, persisting", () => {
    const a: ServiceBusConnection = { id: "a", label: "A", namespace: "a.x" };
    const b: ServiceBusConnection = { id: "b", label: "B", namespace: "b.x" };
    let list = upsertConnection([], a);
    list = upsertConnection(list, b);
    expect(loadConnections()).toHaveLength(2);

    // Update in place (no duplicate).
    list = upsertConnection(list, { ...a, label: "A2" });
    expect(list.filter((c) => c.id === "a")).toHaveLength(1);
    expect(loadConnections().find((c) => c.id === "a")?.label).toBe("A2");

    list = removeConnection(list, "a");
    expect(loadConnections().map((c) => c.id)).toEqual(["b"]);
  });
});
