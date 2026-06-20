import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type {
  GrafanaSummary,
  SentrySummary,
  ServiceBusEntity,
  ServiceBusPeek,
  ServiceBusPurge,
  ServiceBusReceive,
  ServiceBusResubmit,
  ServiceBusSend,
  ServiceBusSnapshot
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { enabledIds, getConnectorConfig, loadConnectorConfig, loadConnectorPrefs } from "../../connectors";
import { formatRelative, useRelativeNow } from "../../relativeTime";
import type { ServiceBusTotals } from "./serviceBusModel";
import { byAttention, filterEntities, serviceBusTotals } from "./serviceBusModel";

export interface ObserveViewProps {
  client: WireClient;
  /** The parent toggles this so a hidden tab makes no host requests. */
  active: boolean;
}

/**
 * Observability hub (connector-fed): the read-only "what's happening" half of the control hub.
 * v1 hosts the Azure Service Bus panel (queues + subscriptions with active / dead-letter
 * counts). Grafana (traces/metrics/logs) and Sentry (errors) slot in as further panels. Only
 * the observability connectors you've enabled are queried; with none on it nudges to Settings.
 */
export function ObserveView({ client, active }: Readonly<ObserveViewProps>): ReactElement {
  const [sources, setSources] = useState<string[]>([]);
  const [grafanaConfig, setGrafanaConfig] = useState<{ baseUrl: string; token: string }>({
    baseUrl: "",
    token: ""
  });
  const [sentryConfig, setSentryConfig] = useState<{
    baseUrl: string;
    org: string;
    project: string;
    token: string;
  }>({ baseUrl: "", org: "", project: "", token: "" });

  useEffect(() => {
    if (active) {
      setSources(enabledIds(loadConnectorPrefs(), "observability"));
      const config = loadConnectorConfig();
      const grafana = getConnectorConfig(config, "grafana");
      setGrafanaConfig({ baseUrl: grafana.baseUrl ?? "", token: grafana.token ?? "" });
      const sentry = getConnectorConfig(config, "sentry");
      setSentryConfig({
        baseUrl: sentry.baseUrl ?? "",
        org: sentry.org ?? "",
        project: sentry.project ?? "",
        token: sentry.token ?? ""
      });
    }
  }, [active]);

  return (
    <section className="observe" aria-label="Observe">
      <header className="observe-header">
        <h2>Observe</h2>
      </header>
      <p className="observe-scope">
        Read-only telemetry from your connected services. Turn connectors on in Settings.
      </p>

      {sources.length === 0 ? (
        <p className="observe-empty">
          No observability connectors enabled. Turn one on in{" "}
          <strong>Settings → Connectors</strong> to see it here.
        </p>
      ) : (
        <>
          {sources.includes("servicebus") && <ServiceBusPanel client={client} active={active} />}
          {sources.includes("grafana") && (
            <GrafanaPanel
              client={client}
              active={active}
              baseUrl={grafanaConfig.baseUrl}
              token={grafanaConfig.token}
            />
          )}
          {sources.includes("sentry") && (
            <SentryPanel client={client} active={active} config={sentryConfig} />
          )}
        </>
      )}
    </section>
  );
}

/** The Azure Service Bus panel: namespace/entity counts with a dead-letter-first table. */
function ServiceBusPanel({
  client,
  active
}: Readonly<{ client: WireClient; active: boolean }>): ReactElement {
  const [snapshot, setSnapshot] = useState<ServiceBusSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const now = useRelativeNow(active);
  // Message peek (read-only): which entity row is expanded, and its latest peek result.
  const [peekKey, setPeekKey] = useState<string | undefined>(undefined);
  const [peek, setPeek] = useState<ServiceBusPeek | undefined>(undefined);
  const [peeking, setPeeking] = useState(false);
  // Dead-letter resubmit (write, confirmation-gated).
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitResult, setResubmitResult] = useState<ServiceBusResubmit | undefined>(undefined);
  // Purge (write, confirmation-gated).
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<ServiceBusPurge | undefined>(undefined);
  // Send (write, confirmation-gated).
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<ServiceBusSend | undefined>(undefined);
  // Receive (write, confirmation-gated).
  const [receiving, setReceiving] = useState(false);
  const [receiveResult, setReceiveResult] = useState<ServiceBusReceive | undefined>(undefined);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.listServiceBus().catch(() => {
      setError("could not read Service Bus");
      setLoading(false);
    });
  }, [client]);

  // After a successful destructive op the list + open peek are stale: clear the peek, show
  // loading, then re-peek the same view and refresh the snapshot.
  const reflectMutation = useCallback(
    (target: {
      namespace: string;
      entity: string;
      subscription?: string;
      deadLetter: boolean;
    }): void => {
      setPeek(undefined);
      setPeeking(true);
      client
        .peekServiceBus({
          namespace: target.namespace,
          entity: target.entity,
          ...(target.subscription === undefined ? {} : { subscription: target.subscription }),
          deadLetter: target.deadLetter,
          count: 20
        })
        .catch(() => undefined);
      client.listServiceBus().catch(() => undefined);
    },
    [client]
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const { payload } = event;
      if (payload.kind === "service_bus_snapshot") {
        setSnapshot(payload.snapshot);
        setUpdatedAt(Date.now());
        setLoading(false);
        setError(undefined);
      } else if (payload.kind === "service_bus_peek") {
        setPeek(payload.peek);
        setPeeking(false);
      } else if (payload.kind === "service_bus_resubmit") {
        const result = payload.result;
        setResubmitResult(result);
        setResubmitting(false);
        if (result.ok) {
          reflectMutation({ ...result, deadLetter: true });
        }
      } else if (payload.kind === "service_bus_purge") {
        const result = payload.result;
        setPurgeResult(result);
        setPurging(false);
        if (result.ok) {
          reflectMutation(result);
        }
      } else if (payload.kind === "service_bus_send") {
        setSendResult(payload.result);
        setSending(false);
        if (payload.result.ok) {
          client.listServiceBus().catch(() => undefined);
        }
      } else if (payload.kind === "service_bus_receive") {
        const result = payload.result;
        setReceiveResult(result);
        setReceiving(false);
        if (result.ok) {
          reflectMutation(result);
        }
      }
    });
    return unsubscribe;
  }, [client, reflectMutation]);

  // Browse messages for one entity (read-only). `entity` is the queue, or the topic when a
  // subscription is given; `deadLetter` peeks the dead-letter sub-queue.
  const doPeek = (
    rowKey: string,
    namespace: string,
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
        namespace,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        deadLetter,
        count: 20
      })
      .catch(() => {
        setPeeking(false);
        setPeek({
          available: false,
          error: "could not peek",
          namespace,
          entity,
          deadLetter,
          messages: []
        });
      });
  };

  // Resubmit (destructive): move the currently-peeked dead-letter messages back to the source.
  // Only meaningful while viewing a dead-letter peek; the UI gates this behind a confirm.
  const doResubmit = (): void => {
    if (peek === undefined || !peek.deadLetter || peek.messages.length === 0) {
      return;
    }
    const { namespace, entity, subscription, messages } = peek;
    setResubmitting(true);
    setResubmitResult(undefined);
    client
      .resubmitDeadLetter({
        namespace,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        count: messages.length
      })
      .catch(() => {
        setResubmitting(false);
        setResubmitResult({ ok: false, error: "could not resubmit", moved: 0, namespace, entity });
      });
  };

  // Purge (destructive): drain all messages from the currently-peeked view (active or DLQ).
  const doPurge = (): void => {
    if (peek === undefined) {
      return;
    }
    const { namespace, entity, subscription, deadLetter } = peek;
    setPurging(true);
    setPurgeResult(undefined);
    client
      .purgeServiceBus({
        namespace,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        deadLetter
      })
      .catch(() => {
        setPurging(false);
        setPurgeResult({
          ok: false,
          error: "could not purge",
          purged: 0,
          namespace,
          entity,
          deadLetter
        });
      });
  };

  // Send (write): publish a message to the currently-peeked entity (queue, or topic for a
  // subscription peek). Confirmation-gated in the UI.
  const doSend = (body: string, subject: string): void => {
    if (peek === undefined || body.trim().length === 0) {
      return;
    }
    const { namespace, entity } = peek;
    setSending(true);
    setSendResult(undefined);
    client
      .sendServiceBus({
        namespace,
        entity,
        body,
        ...(subject.trim().length > 0 ? { subject } : {})
      })
      .catch(() => {
        setSending(false);
        setSendResult({ ok: false, error: "could not send", namespace, entity });
      });
  };

  // Receive (destructive): consume + remove the next message from the currently-peeked view.
  const doReceive = (): void => {
    if (peek === undefined) {
      return;
    }
    const { namespace, entity, subscription, deadLetter } = peek;
    setReceiving(true);
    setReceiveResult(undefined);
    client
      .receiveServiceBus({
        namespace,
        entity,
        ...(subscription === undefined ? {} : { subscription }),
        deadLetter
      })
      .catch(() => {
        setReceiving(false);
        setReceiveResult({
          ok: false,
          error: "could not receive",
          empty: false,
          namespace,
          entity,
          deadLetter
        });
      });
  };

  // Refresh on activation, then poll while the tab is open so counts stay live (a monitoring
  // surface shouldn't need a manual Refresh). 30s is gentle on the `az` calls behind it.
  useEffect(() => {
    if (!active) {
      return;
    }
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const entities = useMemo(
    () =>
      snapshot === undefined
        ? []
        : byAttention(filterEntities(snapshot.namespaces.flatMap((ns) => ns.entities), query)),
    [snapshot, query]
  );
  const totals = useMemo(
    () => (snapshot === undefined ? undefined : serviceBusTotals(snapshot)),
    [snapshot]
  );
  const snapshotUnavailable = snapshot !== undefined && !snapshot.available;
  const emptyMessage =
    query.trim() === "" ? "No queues or subscriptions found." : `No entities match “${query}”.`;

  return (
    <div className="sb-panel">
      <div className="sb-head">
        <h3>Azure Service Bus</h3>
        <div className="sb-actions">
          {updatedAt !== undefined && (
            <span className="updated-stamp">updated {formatRelative(now, updatedAt)}</span>
          )}
          <input
            className="sb-search"
            type="search"
            aria-label="Filter Service Bus entities"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name / namespace…"
          />
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error !== undefined && (
        <p role="alert" className="sb-error">
          {error}
        </p>
      )}

      {snapshotUnavailable && (
        <p className="sb-unavailable">Service Bus: {snapshot?.error ?? "not available"}</p>
      )}

      {snapshot === undefined && (
        <p className="sb-empty">{loading ? "Reading Service Bus…" : "No snapshot yet."}</p>
      )}

      {snapshot !== undefined && snapshot.available && (
        <>
          {totals !== undefined && <SbTotals totals={totals} />}
          {entities.length === 0 ? (
            <p className="sb-empty">{emptyMessage}</p>
          ) : (
            <SbEntityTable entities={entities} onPeek={doPeek} />
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
        </>
      )}
    </div>
  );
}

/** The totals strip: namespace / entity / active / dead-letter counts (DLQ highlighted). */
function SbTotals({ totals }: Readonly<{ totals: ServiceBusTotals }>): ReactElement {
  return (
    <div className="sb-totals">
      <span>
        <strong>{totals.namespaces}</strong> namespaces
      </span>
      <span>
        <strong>{totals.entities}</strong> entities
      </span>
      <span>
        <strong>{totals.active}</strong> active
      </span>
      <span className={totals.deadLetter > 0 ? "sb-dlq-warn" : ""}>
        <strong>{totals.deadLetter}</strong> dead-letter
      </span>
    </div>
  );
}

/** The entity table: one row per queue / subscription with counts and Peek / DLQ actions. */
function SbEntityTable({
  entities,
  onPeek
}: Readonly<{
  entities: ServiceBusEntity[];
  onPeek: (
    rowKey: string,
    namespace: string,
    entity: string,
    subscription: string | undefined,
    deadLetter: boolean
  ) => void;
}>): ReactElement {
  return (
    <table className="sb-table">
      <thead>
        <tr>
          <th scope="col">Entity</th>
          <th scope="col">Namespace</th>
          <th scope="col">Active</th>
          <th scope="col">Dead-letter</th>
          <th scope="col">Scheduled</th>
          <th scope="col">Peek</th>
        </tr>
      </thead>
      <tbody>
        {entities.map((entity) => {
          const rowKey = `${entity.namespace}/${entity.topic ?? ""}/${entity.name}`;
          // For a subscription the peek targets (topic, subscription); for a queue, the queue.
          const peekEntity = entity.topic ?? entity.name;
          const peekSub = entity.kind === "subscription" ? entity.name : undefined;
          const label =
            entity.topic === undefined ? entity.name : `${entity.topic}/${entity.name}`;
          return (
            <tr key={rowKey} className={entity.deadLetter > 0 ? "is-dlq" : ""}>
              <td>
                <span className={`sb-kind sb-kind-${entity.kind}`}>
                  {entity.kind === "queue" ? "Q" : "S"}
                </span>
                {label}
              </td>
              <td className="sb-ns">{entity.namespace}</td>
              <td className="sb-num">{entity.active}</td>
              <td className={`sb-num ${entity.deadLetter > 0 ? "sb-dlq-warn" : ""}`}>
                {entity.deadLetter}
              </td>
              <td className="sb-num">{entity.scheduled}</td>
              <td className="sb-peek-actions">
                <button
                  type="button"
                  onClick={() => onPeek(rowKey, entity.namespace, peekEntity, peekSub, false)}
                >
                  Peek
                </button>
                {entity.deadLetter > 0 && (
                  <button
                    type="button"
                    className="sb-peek-dlq"
                    onClick={() => onPeek(rowKey, entity.namespace, peekEntity, peekSub, true)}
                  >
                    DLQ
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The header line for the peek detail: "Peeking…" until a result lands, then a breadcrumb of
    entity / subscription / dead-letter. */
function peekTitle(peek: ServiceBusPeek | undefined): string {
  if (peek === undefined) {
    return "Peeking…";
  }
  const sub = peek.subscription !== undefined ? `/${peek.subscription}` : "";
  const dlq = peek.deadLetter ? " · dead-letter" : "";
  return `Peek · ${peek.entity}${sub}${dlq}`;
}

/** The body of the peek detail: the loading / empty / unavailable states, or the message list. */
function PeekMessages({
  peeking,
  peek
}: Readonly<{ peeking: boolean; peek: ServiceBusPeek | undefined }>): ReactElement {
  if (peeking) {
    return <p className="sb-empty">Reading messages…</p>;
  }
  if (peek === undefined) {
    return <p className="sb-empty">No messages yet.</p>;
  }
  if (peek.available) {
    if (peek.messages.length === 0) {
      return <p className="sb-empty">No messages to browse. Empty.</p>;
    }
    return (
      <ul className="sb-peek-list">
        {peek.messages.map((message) => (
          <li key={`${message.sequenceNumber}-${message.messageId ?? ""}`} className="sb-peek-msg">
            <div className="sb-peek-msg-head">
              <span className="sb-peek-seq">#{message.sequenceNumber}</span>
              {message.subject !== undefined && (
                <span className="sb-peek-subject">{message.subject}</span>
              )}
              {message.enqueuedTime !== undefined && (
                <span className="sb-peek-time">
                  {message.enqueuedTime.slice(0, 19).replace("T", " ")}
                </span>
              )}
              {message.deliveryCount > 1 && (
                <span className="sb-peek-delivery">×{message.deliveryCount}</span>
              )}
              {message.deadLetterReason !== undefined && (
                <span className="sb-peek-dlr">{message.deadLetterReason}</span>
              )}
            </div>
            <pre className="sb-peek-body">{message.body}</pre>
          </li>
        ))}
      </ul>
    );
  }
  return <p className="sb-unavailable">{peek.error ?? "could not peek"}</p>;
}

/** A live status line for a destructive action's result (ok / error styling). Rendered as an
    <output> (implicit ARIA role="status") so screen readers announce the outcome. */
function ResultLine({ ok, children }: Readonly<{ ok: boolean; children: string }>): ReactElement {
  return (
    <output className={`sb-resubmit-result ${ok ? "is-ok" : "is-error"}`}>
      {children}
    </output>
  );
}

/** The one-line summary of a receive result: error, "nothing to receive", or the consumed message. */
function receiveResultText(result: ServiceBusReceive): string {
  if (!result.ok) {
    return `✗ ${result.error ?? "could not receive"}`;
  }
  if (result.empty) {
    return "✓ Nothing to receive (empty)";
  }
  return `✓ Received & removed #${result.message?.sequenceNumber ?? ""}: ${result.message?.body ?? ""}`;
}

/** The expanded read-only message browse for one entity: a list of peeked messages (id, seq,
    enqueued time, body), or the honest "helper not installed / not signed in" state. When
    viewing a dead-letter peek, offers a confirmation-gated **Resubmit** (move back to source). */
function PeekDetail({
  peeking,
  peek,
  resubmitting,
  resubmitResult,
  onResubmit,
  purging,
  purgeResult,
  onPurge,
  sending,
  sendResult,
  onSend,
  receiving,
  receiveResult,
  onReceive,
  onClose
}: Readonly<{
  peeking: boolean;
  peek: ServiceBusPeek | undefined;
  resubmitting: boolean;
  resubmitResult: ServiceBusResubmit | undefined;
  onResubmit: () => void;
  purging: boolean;
  purgeResult: ServiceBusPurge | undefined;
  onPurge: () => void;
  sending: boolean;
  sendResult: ServiceBusSend | undefined;
  onSend: (body: string, subject: string) => void;
  receiving: boolean;
  receiveResult: ServiceBusReceive | undefined;
  onReceive: () => void;
  onClose: () => void;
}>): ReactElement {
  const canResubmit =
    peek !== undefined && peek.available && peek.deadLetter && peek.messages.length > 0;
  const canPurge = peek?.available === true;
  // Send targets the queue (or the topic, for a subscription peek) — never the DLQ view.
  const canSend = peek !== undefined && peek.available && !peek.deadLetter;
  const canReceive = peek?.available === true;
  const note = peek?.deadLetter
    ? "Peek is read-only; Resubmit moves messages back to the source (needs Data Sender + Receiver)."
    : "Read-only browse: messages are not removed or modified.";

  return (
    <div className="sb-peek">
      <div className="sb-peek-head">
        <h4>{peekTitle(peek)}</h4>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>
      <PeekMessages peeking={peeking} peek={peek} />

      {resubmitResult !== undefined && (
        <ResultLine ok={resubmitResult.ok}>
          {resubmitResult.ok
            ? `✓ Resubmitted ${resubmitResult.moved} message${resubmitResult.moved === 1 ? "" : "s"} to ${resubmitResult.entity}`
            : `✗ ${resubmitResult.error ?? "could not resubmit"}`}
        </ResultLine>
      )}

      {canResubmit && (
        <ResubmitAction peek={peek} resubmitting={resubmitting} onResubmit={onResubmit} />
      )}

      {purgeResult !== undefined && (
        <ResultLine ok={purgeResult.ok}>
          {purgeResult.ok
            ? `✓ Purged ${purgeResult.purged} message${purgeResult.purged === 1 ? "" : "s"} from ${purgeResult.entity}`
            : `✗ ${purgeResult.error ?? "could not purge"}`}
        </ResultLine>
      )}

      {canPurge && <PurgeAction peek={peek} purging={purging} onPurge={onPurge} />}

      {sendResult !== undefined && (
        <ResultLine ok={sendResult.ok}>
          {sendResult.ok ? `✓ Sent to ${sendResult.entity}` : `✗ ${sendResult.error ?? "could not send"}`}
        </ResultLine>
      )}

      {canSend && <SendAction peek={peek} sending={sending} onSend={onSend} />}

      {receiveResult !== undefined && (
        <ResultLine ok={receiveResult.ok}>{receiveResultText(receiveResult)}</ResultLine>
      )}

      {canReceive && <ReceiveAction peek={peek} receiving={receiving} onReceive={onReceive} />}

      <p className="sb-peek-note">{note}</p>
    </div>
  );
}

/** Confirmation-gated **Resubmit**: moves the peeked dead-letter messages back to the source. */
function ResubmitAction({
  peek,
  resubmitting,
  onResubmit
}: Readonly<{
  peek: ServiceBusPeek | undefined;
  resubmitting: boolean;
  onResubmit: () => void;
}>): ReactElement {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="sb-resubmit-btn"
        disabled={resubmitting}
        onClick={() => setConfirming(true)}
      >
        Resubmit {peek?.messages.length} to source
      </button>
    );
  }
  return (
    <div className="sb-resubmit-confirm">
      <span>
        Move {peek?.messages.length} dead-letter message
        {peek?.messages.length === 1 ? "" : "s"} back to <strong>{peek?.entity}</strong>?
        This removes them from the dead-letter queue.
        {peek?.subscription !== undefined && (
          <em className="sb-fanout-note">
            {" "}
            Re-publishes to the topic, fanning out to all of its subscriptions, not just{" "}
            {peek.subscription}.
          </em>
        )}
      </span>
      <button
        type="button"
        className="sb-resubmit-go"
        disabled={resubmitting}
        onClick={() => {
          setConfirming(false);
          onResubmit();
        }}
      >
        {resubmitting ? "Resubmitting…" : "Confirm resubmit"}
      </button>
      <button type="button" className="link-button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}

/** Confirmation-gated **Purge**: drains all messages from the peeked view (active or DLQ). */
function PurgeAction({
  peek,
  purging,
  onPurge
}: Readonly<{
  peek: ServiceBusPeek | undefined;
  purging: boolean;
  onPurge: () => void;
}>): ReactElement {
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  if (!confirmingPurge) {
    return (
      <button
        type="button"
        className="sb-resubmit-btn sb-purge-btn"
        disabled={purging}
        onClick={() => setConfirmingPurge(true)}
      >
        Purge {peek?.deadLetter ? "dead-letter" : "all"}
      </button>
    );
  }
  return (
    <div className="sb-resubmit-confirm sb-purge-confirm">
      <span>
        Permanently delete <strong>ALL</strong> messages in{" "}
        <strong>
          {peek?.entity}
          {peek?.deadLetter ? " (dead-letter)" : ""}
        </strong>
        {"? This cannot be undone."}
      </span>
      <button
        type="button"
        className="sb-resubmit-go"
        disabled={purging}
        onClick={() => {
          setConfirmingPurge(false);
          onPurge();
        }}
      >
        {purging ? "Purging…" : "Confirm purge"}
      </button>
      <button type="button" className="link-button" onClick={() => setConfirmingPurge(false)}>
        Cancel
      </button>
    </div>
  );
}

/** The compose-and-send form (write): publishes a message to the peeked entity. */
function SendAction({
  peek,
  sending,
  onSend
}: Readonly<{
  peek: ServiceBusPeek | undefined;
  sending: boolean;
  onSend: (body: string, subject: string) => void;
}>): ReactElement {
  const [composing, setComposing] = useState(false);
  const [sendBody, setSendBody] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  if (!composing) {
    return (
      <button type="button" className="sb-send-btn" disabled={sending} onClick={() => setComposing(true)}>
        Send a message
      </button>
    );
  }
  return (
    <div className="sb-send-compose">
      {peek?.subscription !== undefined && (
        <p className="sb-fanout-note">
          Sends to topic <strong>{peek.entity}</strong>, fanning out to all of its
          subscriptions, not just {peek.subscription}.
        </p>
      )}
      <label className="sb-send-field">
        <span>Subject (optional)</span>
        <input
          type="text"
          value={sendSubject}
          onChange={(event) => setSendSubject(event.target.value)}
          placeholder="order.created"
        />
      </label>
      <label className="sb-send-field">
        <span>Body</span>
        <textarea
          aria-label="Message body"
          value={sendBody}
          onChange={(event) => setSendBody(event.target.value)}
          placeholder={'{"orderId": 42}'}
          rows={3}
        />
      </label>
      <div className="sb-send-actions">
        <button
          type="button"
          className="sb-resubmit-go"
          disabled={sending || sendBody.trim().length === 0}
          onClick={() => {
            onSend(sendBody, sendSubject);
            setComposing(false);
            setSendBody("");
            setSendSubject("");
          }}
        >
          {sending ? "Sending…" : `Confirm send to ${peek?.entity}`}
        </button>
        <button type="button" className="link-button" onClick={() => setComposing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Confirmation-gated **Receive**: consumes + removes the next message from the peeked view. */
function ReceiveAction({
  peek,
  receiving,
  onReceive
}: Readonly<{
  peek: ServiceBusPeek | undefined;
  receiving: boolean;
  onReceive: () => void;
}>): ReactElement {
  const [confirmingReceive, setConfirmingReceive] = useState(false);
  if (!confirmingReceive) {
    return (
      <button
        type="button"
        className="sb-resubmit-btn sb-purge-btn"
        disabled={receiving}
        onClick={() => setConfirmingReceive(true)}
      >
        Receive one (remove)
      </button>
    );
  }
  return (
    <div className="sb-resubmit-confirm">
      <span>
        Consume and <strong>remove</strong> the next message from{" "}
        <strong>
          {peek?.entity}
          {peek?.deadLetter ? " (dead-letter)" : ""}
        </strong>
        {"? This deletes it."}
      </span>
      <button
        type="button"
        className="sb-resubmit-go"
        disabled={receiving}
        onClick={() => {
          setConfirmingReceive(false);
          onReceive();
        }}
      >
        {receiving ? "Receiving…" : "Confirm receive"}
      </button>
      <button type="button" className="link-button" onClick={() => setConfirmingReceive(false)}>
        Cancel
      </button>
    </div>
  );
}

/** The Grafana panel: health + dashboards as deep-links, fed by the locally-held config.
    Honest about state — "not configured" until a base URL is set, and a clear error when the
    instance is unreachable or rejects the token. */
function GrafanaPanel({
  client,
  active,
  baseUrl,
  token
}: Readonly<{ client: WireClient; active: boolean; baseUrl: string; token: string }>): ReactElement {
  const [summary, setSummary] = useState<GrafanaSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const now = useRelativeNow(active);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.grafanaSummary(baseUrl, token).catch(() => {
      setError("could not read Grafana");
      setLoading(false);
    });
  }, [client, baseUrl, token]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "grafana_summary") {
        setSummary(event.payload.summary);
        setUpdatedAt(Date.now());
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  // Refresh on activation + poll while open, but only when configured (no point hitting an
  // empty base URL on a timer).
  useEffect(() => {
    if (!active || baseUrl.trim() === "") {
      return;
    }
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [active, refresh, baseUrl]);

  const notConfigured = baseUrl.trim() === "";

  return (
    <div className="grafana-panel">
      <div className="sb-head">
        <h3>Grafana</h3>
        {!notConfigured && (
          <div className="sb-actions">
            {updatedAt !== undefined && (
              <span className="updated-stamp">updated {formatRelative(now, updatedAt)}</span>
            )}
            <a className="grafana-open" href={baseUrl} target="_blank" rel="noreferrer">
              Open Grafana
            </a>
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </button>
          </div>
        )}
      </div>

      {error !== undefined && (
        <p role="alert" className="sb-error">
          {error}
        </p>
      )}

      <GrafanaBody notConfigured={notConfigured} summary={summary} loading={loading} />
    </div>
  );
}

/** The Grafana panel body: not-configured / loading / unavailable states, or the health +
    dashboards view. */
function GrafanaBody({
  notConfigured,
  summary,
  loading
}: Readonly<{
  notConfigured: boolean;
  summary: GrafanaSummary | undefined;
  loading: boolean;
}>): ReactElement {
  if (notConfigured) {
    return (
      <p className="sb-unavailable">
        Not configured. Add your Grafana base URL (and an API token) in{" "}
        <strong>Settings → Connectors</strong> to see health and dashboards here.
      </p>
    );
  }
  if (summary === undefined) {
    return <p className="sb-empty">{loading ? "Reading Grafana…" : "No summary yet."}</p>;
  }
  if (!summary.available) {
    return <p className="sb-unavailable">Grafana: {summary.error ?? "not available"}</p>;
  }
  return (
    <>
      <div className="sb-totals">
        <span>
          version <strong>{summary.version ?? "-"}</strong>
        </span>
        <span>
          database <strong>{summary.database ?? "-"}</strong>
        </span>
        <span>
          <strong>{summary.dashboards.length}</strong> dashboards
        </span>
      </div>
      {summary.dashboards.length === 0 ? (
        <p className="sb-empty">No dashboards found.</p>
      ) : (
        <ul className="grafana-dashboards">
          {summary.dashboards.map((dashboard) => (
            <li key={dashboard.uid || dashboard.url}>
              <a href={dashboard.url} target="_blank" rel="noreferrer">
                {dashboard.title}
              </a>
              {dashboard.folder !== undefined && (
                <span className="grafana-folder">{dashboard.folder}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The Sentry panel: unresolved issues (level-tagged, event/user counts), each linking out to
    Sentry. Honest "not configured" / unavailable states like the other connectors. */
function SentryPanel({
  client,
  active,
  config
}: Readonly<{
  client: WireClient;
  active: boolean;
  config: { baseUrl: string; org: string; project: string; token: string };
}>): ReactElement {
  const [summary, setSummary] = useState<SentrySummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const now = useRelativeNow(active);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.sentrySummary(config).catch(() => {
      setError("could not read Sentry");
      setLoading(false);
    });
  }, [client, config]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "sentry_summary") {
        setSummary(event.payload.summary);
        setUpdatedAt(Date.now());
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  const notConfigured =
    config.org.trim() === "" || config.project.trim() === "" || config.token.trim() === "";

  // Refresh on activation + poll while open, but only when configured.
  useEffect(() => {
    if (!active || notConfigured) {
      return;
    }
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [active, refresh, notConfigured]);

  return (
    <div className="sentry-panel">
      <div className="sb-head">
        <h3>Sentry</h3>
        {!notConfigured && (
          <div className="sb-actions">
            {updatedAt !== undefined && (
              <span className="updated-stamp">updated {formatRelative(now, updatedAt)}</span>
            )}
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </button>
          </div>
        )}
      </div>

      {error !== undefined && (
        <p role="alert" className="sb-error">
          {error}
        </p>
      )}

      <SentryBody notConfigured={notConfigured} summary={summary} loading={loading} />
    </div>
  );
}

/** The Sentry panel body: not-configured / loading / unavailable / empty states, or the list of
    unresolved issues. */
function SentryBody({
  notConfigured,
  summary,
  loading
}: Readonly<{
  notConfigured: boolean;
  summary: SentrySummary | undefined;
  loading: boolean;
}>): ReactElement {
  if (notConfigured) {
    return (
      <p className="sb-unavailable">
        Not configured. Add your Sentry org, project, and API token in{" "}
        <strong>Settings → Connectors</strong> to see unresolved issues here.
      </p>
    );
  }
  if (summary === undefined) {
    return <p className="sb-empty">{loading ? "Reading Sentry…" : "No summary yet."}</p>;
  }
  if (!summary.available) {
    return <p className="sb-unavailable">Sentry: {summary.error ?? "not available"}</p>;
  }
  if (summary.issues.length === 0) {
    return <p className="sb-empty">No unresolved issues. 🎉</p>;
  }
  return (
    <ul className="sentry-issues">
      {summary.issues.map((issue) => (
        <li key={issue.id} className={`sentry-issue level-${issue.level}`}>
          <a className="sentry-title" href={issue.permalink} target="_blank" rel="noreferrer">
            {issue.title}
          </a>
          <div className="sentry-meta">
            <span className={`sentry-level level-${issue.level}`}>{issue.level}</span>
            {issue.culprit !== undefined && (
              <span className="sentry-culprit">{issue.culprit}</span>
            )}
            <span className="sentry-count">{issue.count} events</span>
            <span className="sentry-users">{issue.userCount} users</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
