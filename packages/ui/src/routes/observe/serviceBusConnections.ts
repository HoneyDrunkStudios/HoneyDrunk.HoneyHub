// Saved Service Bus connections (cockpit-held). A connection authenticates EITHER via Azure
// AD (just a namespace FQDN, reusing the operator's az login) OR a SAS connection string
// (a secret). Per ADR-0094 D3 the host never persists secrets — connection strings live here,
// in the cockpit's localStorage, and ride per-request on the wire. The user can save many
// connections and open several at once.

export interface ServiceBusConnection {
  id: string;
  label: string;
  /** The namespace FQDN (derived from the connection string when only that was given). */
  namespace: string;
  /** Optional SAS connection string — a secret. Absent = Azure AD auth. */
  connectionString?: string;
}

const STORAGE_KEY = "honeyhub.serviceBusConnections.v1";

/** Derive a namespace FQDN from a SAS connection string's `Endpoint=sb://<host>/`. Returns
    "" when it can't be parsed (the caller then requires an explicit namespace). */
export function namespaceFromConnectionString(connectionString: string): string {
  const match = /endpoint=sb:\/\/([^/;]+)/i.exec(connectionString);
  return match?.[1]?.trim() ?? "";
}

/** Load saved connections, tolerating missing/corrupt storage. Never throws. */
export function loadConnections(): ServiceBusConnection[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is ServiceBusConnection =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ServiceBusConnection).id === "string" &&
        typeof (item as ServiceBusConnection).namespace === "string"
    );
  } catch {
    return [];
  }
}

function save(connections: ServiceBusConnection[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(connections));
  } catch {
    // Best-effort: a cockpit that can't persist still works for the session.
  }
}

export interface ConnectionDraft {
  label: string;
  namespace: string;
  connectionString?: string;
}

/** Normalize a draft into a connection (derive the namespace from the connection string when
    the namespace field is blank). Throws when neither a namespace nor a usable connection
    string is provided, or the label is empty. */
export function connectionFromDraft(draft: ConnectionDraft, id: string): ServiceBusConnection {
  const label = draft.label.trim();
  if (label.length === 0) {
    throw new Error("a connection name is required");
  }
  const connectionString = draft.connectionString?.trim();
  let namespace = draft.namespace.trim();
  if (namespace.length === 0 && connectionString !== undefined && connectionString.length > 0) {
    namespace = namespaceFromConnectionString(connectionString);
  }
  if (namespace.length === 0) {
    throw new Error("a namespace (or a connection string to derive it from) is required");
  }
  return {
    id,
    label,
    namespace,
    ...(connectionString !== undefined && connectionString.length > 0 ? { connectionString } : {})
  };
}

/** Insert or update a connection by id, persisting the result. Returns the new list. */
export function upsertConnection(
  connections: ServiceBusConnection[],
  connection: ServiceBusConnection
): ServiceBusConnection[] {
  const exists = connections.some((item) => item.id === connection.id);
  const next = exists
    ? connections.map((item) => (item.id === connection.id ? connection : item))
    : [...connections, connection];
  save(next);
  return next;
}

/** Remove a connection by id, persisting the result. Returns the new list. */
export function removeConnection(
  connections: ServiceBusConnection[],
  id: string
): ServiceBusConnection[] {
  const next = connections.filter((item) => item.id !== id);
  save(next);
  return next;
}

/** The wire-facing auth pair for a connection: its namespace + optional connection string. */
export function connectionAuth(connection: ServiceBusConnection): {
  namespace: string;
  connectionString?: string;
} {
  return {
    namespace: connection.namespace,
    ...(connection.connectionString === undefined
      ? {}
      : { connectionString: connection.connectionString })
  };
}
