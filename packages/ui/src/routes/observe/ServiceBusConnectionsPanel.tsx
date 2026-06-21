import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type {
  SbEntityProps,
  SbQueue,
  SbSubscription,
  SbTopic,
  ServiceBusEntities,
  ServiceBusPeek,
  ServiceBusPurge,
  ServiceBusReceive,
  ServiceBusResubmit,
  ServiceBusSend
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { NumberField } from "../../components/NumberField";
import { PeekDetail } from "./ObserveView";
import {
  connectionAuth,
  connectionFromDraft,
  loadConnections,
  removeConnection,
  upsertConnection,
  type ServiceBusConnection
} from "./serviceBusConnections";

export interface ServiceBusConnectionsPanelProps {
  client: WireClient;
  active: boolean;
}

/** The Service Bus connections surface: save namespaces (Azure AD) or SAS connection strings,
    open several at once, browse + manage each one's entities. Sits above the AAD-discovered
    snapshot panel. Secrets are cockpit-held + sent per request (ADR-0094 D3). */
export function ServiceBusConnectionsPanel({
  client,
  active
}: Readonly<ServiceBusConnectionsPanelProps>): ReactElement {
  const [connections, setConnections] = useState<ServiceBusConnection[]>(loadConnections);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [namespace, setNamespace] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const openAdd = (): void => {
    setEditingId(undefined);
    setLabel("");
    setNamespace("");
    setConnectionString("");
    setFormError(undefined);
    setFormOpen(true);
  };

  const openEdit = (connection: ServiceBusConnection): void => {
    setEditingId(connection.id);
    setLabel(connection.label);
    setNamespace(connection.namespace);
    setConnectionString(connection.connectionString ?? "");
    setFormError(undefined);
    setFormOpen(true);
  };

  const save = (): void => {
    try {
      const id = editingId ?? crypto.randomUUID();
      const connection = connectionFromDraft(
        { label, namespace, connectionString },
        id
      );
      setConnections((prev) => upsertConnection(prev, connection));
      setFormOpen(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "could not save the connection");
    }
  };

  const remove = (id: string): void => {
    setConnections((prev) => removeConnection(prev, id));
  };

  return (
    <div className="sb-panel sb-connections">
      <div className="sb-head">
        <h3>Service Bus connections</h3>
        <div className="sb-actions">
          <button type="button" onClick={openAdd}>
            Add connection
          </button>
        </div>
      </div>

      {formOpen && (
        <div className="sb-conn-form">
          <label className="sb-send-field">
            <span>Name</span>
            <input
              type="text"
              aria-label="Connection name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Dev namespace"
            />
          </label>
          <label className="sb-send-field">
            <span>Namespace (FQDN, for Azure AD)</span>
            <input
              type="text"
              aria-label="Namespace"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="hd-bus-dev.servicebus.windows.net"
            />
          </label>
          <label className="sb-send-field">
            <span>Connection string (optional — for namespaces outside your az login)</span>
            <input
              type="password"
              aria-label="Connection string"
              value={connectionString}
              onChange={(event) => setConnectionString(event.target.value)}
              placeholder="Endpoint=sb://…;SharedAccessKey=…"
            />
          </label>
          <p className="sb-peek-note">
            With no connection string, the connection uses your Azure AD sign-in (no secret
            stored). A connection string is kept only in this browser and sent per request.
          </p>
          {formError !== undefined && (
            <p role="alert" className="sb-error">
              {formError}
            </p>
          )}
          <div className="sb-send-actions">
            <button type="button" className="sb-resubmit-go" onClick={save}>
              {editingId === undefined ? "Save connection" : "Update connection"}
            </button>
            <button type="button" className="link-button" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {connections.length === 0 ? (
        <p className="sb-empty">
          No saved connections. Add one to browse and manage a Service Bus namespace.
        </p>
      ) : (
        <ul className="sb-conn-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionPanel
                client={client}
                active={active}
                connection={connection}
                onEdit={() => openEdit(connection)}
                onRemove={() => remove(connection.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fqdnOf(namespace: string): string {
  const trimmed = namespace.trim();
  return trimmed.includes(".") ? trimmed : `${trimmed}.servicebus.windows.net`;
}

interface ConnectionPanelProps {
  client: WireClient;
  active: boolean;
  connection: ServiceBusConnection;
  onEdit: () => void;
  onRemove: () => void;
}

/** One saved connection: expand to list + manage its entities, browse messages, and run the
    data-plane ops. Owns its own state so several connections can be open at once. */
function ConnectionPanel({
  client,
  active,
  connection,
  onEdit,
  onRemove
}: Readonly<ConnectionPanelProps>): ReactElement {
  const fqdn = fqdnOf(connection.namespace);
  const auth = connectionAuth(connection);
  const [open, setOpen] = useState(false);
  const [entities, setEntities] = useState<ServiceBusEntities | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Peek + data-plane op state (one peek open at a time for this connection).
  const [peekKey, setPeekKey] = useState<string | undefined>(undefined);
  const [peek, setPeek] = useState<ServiceBusPeek | undefined>(undefined);
  const [peeking, setPeeking] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitResult, setResubmitResult] = useState<ServiceBusResubmit | undefined>(undefined);
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<ServiceBusPurge | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<ServiceBusSend | undefined>(undefined);
  const [receiving, setReceiving] = useState(false);
  const [receiveResult, setReceiveResult] = useState<ServiceBusReceive | undefined>(undefined);

  const listEntities = (): void => {
    setLoading(true);
    client.listServiceBusEntities(auth).catch(() => setLoading(false));
  };

  // Subscribe to this connection's events (filtered by its namespace).
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const { payload } = event;
      if (payload.kind === "service_bus_entities") {
        if (payload.entities.namespace === fqdn) {
          setEntities(payload.entities);
          setLoading(false);
        }
      } else if (payload.kind === "service_bus_manage") {
        if (payload.result.namespace === fqdn) {
          const { result } = payload;
          setFeedback(
            result.ok
              ? `✓ ${result.message ?? `${result.op} ${result.kind} ${result.entity}`}`
              : `✗ ${result.error ?? "operation failed"}`
          );
          if (result.ok) {
            listEntities();
          }
        }
      } else if (payload.kind === "service_bus_peek") {
        if (payload.peek.namespace === fqdn) {
          setPeek(payload.peek);
          setPeeking(false);
        }
      } else if (payload.kind === "service_bus_resubmit") {
        if (payload.result.namespace === fqdn) {
          setResubmitResult(payload.result);
          setResubmitting(false);
          if (payload.result.ok) {
            reflect(payload.result.entity, payload.result.subscription, true);
          }
        }
      } else if (payload.kind === "service_bus_purge") {
        if (payload.result.namespace === fqdn) {
          setPurgeResult(payload.result);
          setPurging(false);
          if (payload.result.ok) {
            reflect(payload.result.entity, payload.result.subscription, payload.result.deadLetter);
          }
        }
      } else if (payload.kind === "service_bus_send") {
        if (payload.result.namespace === fqdn) {
          setSendResult(payload.result);
          setSending(false);
          if (payload.result.ok) {
            listEntities();
          }
        }
      } else if (payload.kind === "service_bus_receive") {
        if (payload.result.namespace === fqdn) {
          setReceiveResult(payload.result);
          setReceiving(false);
          if (payload.result.ok) {
            reflect(payload.result.entity, payload.result.subscription, payload.result.deadLetter);
          }
        }
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fqdn]);

  // After a destructive op, re-peek the same view + re-list the entities.
  const reflect = (entity: string, subscription: string | undefined, deadLetter: boolean): void => {
    setPeek(undefined);
    setPeeking(true);
    client
      .peekServiceBus({
        ...auth,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        deadLetter,
        count: 20
      })
      .catch(() => undefined);
    listEntities();
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && entities === undefined) {
      listEntities();
    }
  };

  const doPeek = (
    rowKey: string,
    entity: string,
    subscription: string | undefined,
    deadLetter: boolean
  ): void => {
    setPeekKey(rowKey);
    setPeek(undefined);
    setPeeking(true);
    setResubmitResult(undefined);
    setPurgeResult(undefined);
    setSendResult(undefined);
    setReceiveResult(undefined);
    client
      .peekServiceBus({
        ...auth,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        deadLetter,
        count: 20
      })
      .catch(() => {
        setPeeking(false);
        setPeek({ available: false, error: "could not peek", namespace: fqdn, entity, deadLetter, messages: [] });
      });
  };

  const doResubmit = (): void => {
    if (peek === undefined || !peek.deadLetter || peek.messages.length === 0) {
      return;
    }
    setResubmitting(true);
    setResubmitResult(undefined);
    client
      .resubmitDeadLetter({
        ...auth,
        entity: peek.entity,
        ...(peek.subscription === undefined ? {} : { subscription: peek.subscription }),
        count: peek.messages.length
      })
      .catch(() => {
        setResubmitting(false);
        setResubmitResult({ ok: false, error: "could not resubmit", moved: 0, namespace: fqdn, entity: peek.entity });
      });
  };

  const doPurge = (): void => {
    if (peek === undefined) {
      return;
    }
    setPurging(true);
    setPurgeResult(undefined);
    client
      .purgeServiceBus({
        ...auth,
        entity: peek.entity,
        ...(peek.subscription === undefined ? {} : { subscription: peek.subscription }),
        deadLetter: peek.deadLetter
      })
      .catch(() => {
        setPurging(false);
        setPurgeResult({ ok: false, error: "could not purge", purged: 0, namespace: fqdn, entity: peek.entity, deadLetter: peek.deadLetter });
      });
  };

  const doSend = (body: string, subject: string): void => {
    if (peek === undefined || body.trim().length === 0) {
      return;
    }
    setSending(true);
    setSendResult(undefined);
    client
      .sendServiceBus({
        ...auth,
        entity: peek.entity,
        body,
        ...(subject.trim().length > 0 ? { subject } : {})
      })
      .catch(() => {
        setSending(false);
        setSendResult({ ok: false, error: "could not send", namespace: fqdn, entity: peek.entity });
      });
  };

  const doReceive = (): void => {
    if (peek === undefined) {
      return;
    }
    setReceiving(true);
    setReceiveResult(undefined);
    client
      .receiveServiceBus({
        ...auth,
        entity: peek.entity,
        ...(peek.subscription === undefined ? {} : { subscription: peek.subscription }),
        deadLetter: peek.deadLetter
      })
      .catch(() => {
        setReceiving(false);
        setReceiveResult({ ok: false, error: "could not receive", empty: false, namespace: fqdn, entity: peek.entity, deadLetter: peek.deadLetter });
      });
  };

  const manage = (
    op: "create" | "delete" | "update",
    entityKind: "queue" | "topic" | "subscription",
    entity: string,
    subscription: string | undefined,
    props: SbEntityProps | undefined
  ): void => {
    setFeedback(undefined);
    client
      .manageServiceBus({
        ...auth,
        op,
        entityKind,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        ...(props === undefined ? {} : { props })
      })
      .catch(() => setFeedback("✗ could not reach the helper"));
  };

  return (
    <div className="sb-conn">
      <div className="sb-conn-head">
        <button type="button" className="sb-conn-toggle" aria-expanded={open} onClick={toggle}>
          <span className="git-repo-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="sb-conn-label">{connection.label}</span>
          <span className="sb-conn-ns">{connection.namespace}</span>
          <span className={`sb-conn-auth ${connection.connectionString === undefined ? "is-aad" : "is-sas"}`}>
            {connection.connectionString === undefined ? "Azure AD" : "connection string"}
          </span>
        </button>
        <div className="sb-conn-actions">
          <button type="button" className="git-link" onClick={onEdit}>
            Edit
          </button>
          {confirmRemove ? (
            <>
              <button type="button" className="git-link git-discard" onClick={onRemove}>
                Confirm remove
              </button>
              <button type="button" className="git-link" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="git-link git-discard" onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="sb-conn-body">
          <div className="sb-conn-toolbar">
            <button type="button" onClick={listEntities} disabled={loading}>
              {loading ? "Reading…" : "Refresh entities"}
            </button>
          </div>

          {feedback !== undefined && (
            <output className={`sb-resubmit-result ${feedback.startsWith("✓") ? "is-ok" : "is-error"}`}>
              {feedback}
            </output>
          )}

          {entities !== undefined && !entities.available && (
            <p className="sb-unavailable">{entities.error ?? "not available"}</p>
          )}

          {entities?.available && (
            <EntityExplorer
              entities={entities}
              onPeek={doPeek}
              onManage={manage}
            />
          )}

          {peekKey !== undefined && (
            <PeekDetail
              peeking={peeking}
              peek={peek}
              resubmitting={resubmitting}
              resubmitResult={resubmitResult}
              onResubmit={doResubmit}
              purging={purging}
              purgeResult={purgeResult}
              onPurge={doPurge}
              sending={sending}
              sendResult={sendResult}
              onSend={doSend}
              receiving={receiving}
              receiveResult={receiveResult}
              onReceive={doReceive}
              onClose={() => {
                setPeekKey(undefined);
                setPeek(undefined);
                setResubmitResult(undefined);
                setPurgeResult(undefined);
                setSendResult(undefined);
                setReceiveResult(undefined);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

type ManageFn = (
  op: "create" | "delete" | "update",
  entityKind: "queue" | "topic" | "subscription",
  entity: string,
  subscription: string | undefined,
  props: SbEntityProps | undefined
) => void;

/** The entity explorer for one connection: queues, topics + subscriptions, with counts, peek,
    properties editing, delete, and create. */
function EntityExplorer({
  entities,
  onPeek,
  onManage
}: Readonly<{
  entities: ServiceBusEntities;
  onPeek: (rowKey: string, entity: string, subscription: string | undefined, deadLetter: boolean) => void;
  onManage: ManageFn;
}>): ReactElement {
  const [newQueue, setNewQueue] = useState("");
  const [newTopic, setNewTopic] = useState("");

  return (
    <div className="sb-explorer">
      <div className="sb-explorer-group">
        <p className="sb-explorer-title">Queues</p>
        {entities.queues.length === 0 ? (
          <p className="sb-empty">No queues.</p>
        ) : (
          <ul className="sb-explorer-list">
            {entities.queues.map((queue) => (
              <QueueRow key={queue.name} queue={queue} onPeek={onPeek} onManage={onManage} />
            ))}
          </ul>
        )}
        <form
          className="git-new-branch"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newQueue.trim();
            if (name.length > 0) {
              onManage("create", "queue", name, undefined, undefined);
              setNewQueue("");
            }
          }}
        >
          <input
            aria-label="New queue name"
            value={newQueue}
            placeholder="new queue…"
            onChange={(event) => setNewQueue(event.target.value)}
          />
          <button type="submit" disabled={newQueue.trim().length === 0}>
            Create queue
          </button>
        </form>
      </div>

      <div className="sb-explorer-group">
        <p className="sb-explorer-title">Topics</p>
        {entities.topics.length === 0 ? (
          <p className="sb-empty">No topics.</p>
        ) : (
          <ul className="sb-explorer-list">
            {entities.topics.map((topic) => (
              <TopicRow key={topic.name} topic={topic} onPeek={onPeek} onManage={onManage} />
            ))}
          </ul>
        )}
        <form
          className="git-new-branch"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newTopic.trim();
            if (name.length > 0) {
              onManage("create", "topic", name, undefined, undefined);
              setNewTopic("");
            }
          }}
        >
          <input
            aria-label="New topic name"
            value={newTopic}
            placeholder="new topic…"
            onChange={(event) => setNewTopic(event.target.value)}
          />
          <button type="submit" disabled={newTopic.trim().length === 0}>
            Create topic
          </button>
        </form>
      </div>
    </div>
  );
}

function QueueRow({
  queue,
  onPeek,
  onManage
}: Readonly<{ queue: SbQueue; onPeek: EntityExplorerPeek; onManage: ManageFn }>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className={`sb-explorer-row ${queue.deadLetter > 0 ? "is-dlq" : ""}`}>
      <div className="sb-explorer-main">
        <span className="sb-kind sb-kind-queue">Q</span>
        <span className="sb-explorer-name">{queue.name}</span>
        <span className="sb-explorer-counts">
          {queue.active} active
          {queue.deadLetter > 0 && <span className="sb-dlq-warn"> · {queue.deadLetter} DLQ</span>}
        </span>
      </div>
      <div className="sb-explorer-actions">
        <button type="button" onClick={() => onPeek(`q:${queue.name}`, queue.name, undefined, false)}>
          Peek
        </button>
        {queue.deadLetter > 0 && (
          <button
            type="button"
            className="sb-peek-dlq"
            onClick={() => onPeek(`q:${queue.name}:dlq`, queue.name, undefined, true)}
          >
            DLQ
          </button>
        )}
        <button type="button" className="git-link" onClick={() => setEditing((value) => !value)}>
          Edit
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="git-link git-discard"
              onClick={() => onManage("delete", "queue", queue.name, undefined, undefined)}
            >
              Confirm delete
            </button>
            <button type="button" className="git-link" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="git-link git-discard" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
      {editing && (
        <PropsEditor
          initial={queue.props}
          kind="queue"
          onSave={(props) => {
            onManage("update", "queue", queue.name, undefined, props);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

type EntityExplorerPeek = (
  rowKey: string,
  entity: string,
  subscription: string | undefined,
  deadLetter: boolean
) => void;

function TopicRow({
  topic,
  onPeek,
  onManage
}: Readonly<{ topic: SbTopic; onPeek: EntityExplorerPeek; onManage: ManageFn }>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newSub, setNewSub] = useState("");
  return (
    <li className="sb-explorer-row sb-topic-row">
      <div className="sb-explorer-main">
        <span className="sb-kind sb-kind-topic">T</span>
        <span className="sb-explorer-name">{topic.name}</span>
        <span className="sb-explorer-counts">{topic.subscriptions.length} subscriptions</span>
      </div>
      <div className="sb-explorer-actions">
        <button type="button" className="git-link" onClick={() => setEditing((value) => !value)}>
          Edit
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="git-link git-discard"
              onClick={() => onManage("delete", "topic", topic.name, undefined, undefined)}
            >
              Confirm delete
            </button>
            <button type="button" className="git-link" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="git-link git-discard" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
      {editing && (
        <PropsEditor
          initial={topic.props}
          kind="topic"
          onSave={(props) => {
            onManage("update", "topic", topic.name, undefined, props);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      <ul className="sb-sub-list">
        {topic.subscriptions.map((sub) => (
          <SubscriptionRow
            key={sub.name}
            topic={topic.name}
            sub={sub}
            onPeek={onPeek}
            onManage={onManage}
          />
        ))}
      </ul>
      <form
        className="git-new-branch sb-sub-create"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newSub.trim();
          if (name.length > 0) {
            onManage("create", "subscription", topic.name, name, undefined);
            setNewSub("");
          }
        }}
      >
        <input
          aria-label={`New subscription on ${topic.name}`}
          value={newSub}
          placeholder="new subscription…"
          onChange={(event) => setNewSub(event.target.value)}
        />
        <button type="submit" disabled={newSub.trim().length === 0}>
          Add subscription
        </button>
      </form>
    </li>
  );
}

function SubscriptionRow({
  topic,
  sub,
  onPeek,
  onManage
}: Readonly<{ topic: string; sub: SbSubscription; onPeek: EntityExplorerPeek; onManage: ManageFn }>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className={`sb-explorer-row sb-sub-row ${sub.deadLetter > 0 ? "is-dlq" : ""}`}>
      <div className="sb-explorer-main">
        <span className="sb-kind sb-kind-subscription">S</span>
        <span className="sb-explorer-name">{sub.name}</span>
        <span className="sb-explorer-counts">
          {sub.active} active
          {sub.deadLetter > 0 && <span className="sb-dlq-warn"> · {sub.deadLetter} DLQ</span>}
        </span>
      </div>
      <div className="sb-explorer-actions">
        <button type="button" onClick={() => onPeek(`s:${topic}/${sub.name}`, topic, sub.name, false)}>
          Peek
        </button>
        {sub.deadLetter > 0 && (
          <button
            type="button"
            className="sb-peek-dlq"
            onClick={() => onPeek(`s:${topic}/${sub.name}:dlq`, topic, sub.name, true)}
          >
            DLQ
          </button>
        )}
        <button type="button" className="git-link" onClick={() => setEditing((value) => !value)}>
          Edit
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="git-link git-discard"
              onClick={() => onManage("delete", "subscription", topic, sub.name, undefined)}
            >
              Confirm delete
            </button>
            <button type="button" className="git-link" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="git-link git-discard" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
      {editing && (
        <PropsEditor
          initial={sub.props}
          kind="subscription"
          onSave={(props) => {
            onManage("update", "subscription", topic, sub.name, props);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

/** A focused property editor. Empty fields are left unchanged on the entity. */
function PropsEditor({
  initial,
  kind,
  onSave,
  onCancel
}: Readonly<{
  initial: SbEntityProps;
  kind: "queue" | "topic" | "subscription";
  onSave: (props: SbEntityProps) => void;
  onCancel: () => void;
}>): ReactElement {
  const [maxSizeMb, setMaxSizeMb] = useState(initial.maxSizeMb?.toString() ?? "");
  const [maxDeliveryCount, setMaxDeliveryCount] = useState(initial.maxDeliveryCount?.toString() ?? "");
  const [lockDurationSeconds, setLockDurationSeconds] = useState(
    initial.lockDurationSeconds?.toString() ?? ""
  );
  const [defaultTtlSeconds, setDefaultTtlSeconds] = useState(
    initial.defaultTtlSeconds !== undefined && initial.defaultTtlSeconds >= 0
      ? initial.defaultTtlSeconds.toString()
      : ""
  );
  const [deadLetterOnExpiration, setDeadLetterOnExpiration] = useState(
    initial.deadLetterOnExpiration ?? false
  );
  const [status, setStatus] = useState(initial.status ?? "");

  const num = (value: string): number | undefined => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const submit = (): void => {
    const props: SbEntityProps = {};
    const size = num(maxSizeMb);
    if (size !== undefined && kind !== "subscription") props.maxSizeMb = size;
    const mdc = num(maxDeliveryCount);
    if (mdc !== undefined && kind !== "topic") props.maxDeliveryCount = mdc;
    const lock = num(lockDurationSeconds);
    if (lock !== undefined && kind !== "topic") props.lockDurationSeconds = lock;
    const ttl = num(defaultTtlSeconds);
    if (ttl !== undefined) props.defaultTtlSeconds = ttl;
    if (kind !== "topic") props.deadLetterOnExpiration = deadLetterOnExpiration;
    if (status.trim().length > 0) props.status = status.trim();
    onSave(props);
  };

  return (
    <div className="sb-props-editor">
      {kind !== "subscription" && (
        <label className="sb-prop-field">
          <span>Max size (MB)</span>
          <NumberField value={maxSizeMb} onChange={setMaxSizeMb} min={0} step={1024} ariaLabel="Max size (MB)" />
        </label>
      )}
      {kind !== "topic" && (
        <>
          <label className="sb-prop-field">
            <span>Max delivery count</span>
            <NumberField value={maxDeliveryCount} onChange={setMaxDeliveryCount} min={1} ariaLabel="Max delivery count" />
          </label>
          <label className="sb-prop-field">
            <span>Lock duration (s)</span>
            <NumberField value={lockDurationSeconds} onChange={setLockDurationSeconds} min={0} step={5} ariaLabel="Lock duration (s)" />
          </label>
        </>
      )}
      <label className="sb-prop-field">
        <span>Default TTL (s)</span>
        <NumberField value={defaultTtlSeconds} onChange={setDefaultTtlSeconds} min={0} step={60} ariaLabel="Default TTL (s)" />
      </label>
      {kind !== "topic" && (
        <label className="sb-prop-check">
          <input
            type="checkbox"
            checked={deadLetterOnExpiration}
            onChange={(event) => setDeadLetterOnExpiration(event.target.checked)}
          />
          <span>Dead-letter on expiration</span>
        </label>
      )}
      <label className="sb-prop-field">
        <span>Status</span>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">(unchanged)</option>
          <option value="Active">Active</option>
          <option value="Disabled">Disabled</option>
        </select>
      </label>
      <div className="sb-send-actions">
        <button type="button" className="sb-resubmit-go" onClick={submit}>
          Save properties
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
