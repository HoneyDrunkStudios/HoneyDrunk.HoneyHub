import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { WireClient } from "../../wire/client";
import {
  enabledIds,
  getConnectorConfig,
  loadConnectorConfig,
  loadConnectorPrefs
} from "../../connectors";
import { attentionTone, formatRelative, type CardTone } from "./hubModel";

export interface HubViewProps {
  client: WireClient;
  active: boolean;
  /** Jump to another tab when a card is clicked. */
  onNavigate: (view: "work" | "observe") => void;
}

interface SourceState {
  value: number;
  tone: CardTone;
  updatedAt?: number;
  error?: string;
}

const EMPTY: SourceState = { value: 0, tone: "muted" };

/**
 * Hub overview — the "one glance" landing. Pulls the headline number from each enabled
 * connector (assigned work, dead-letter backlog, unresolved errors, Grafana dashboards) into
 * a card grid with a per-source "updated" stamp and a Refresh-all. Each card jumps to its
 * detail tab. Nothing is queried for connectors you haven't enabled.
 */
export function HubView({ client, active, onNavigate }: Readonly<HubViewProps>): ReactElement {
  const [work, setWork] = useState<SourceState>(EMPTY);
  const [serviceBus, setServiceBus] = useState<SourceState>(EMPTY);
  const [grafana, setGrafana] = useState<SourceState>(EMPTY);
  const [sentry, setSentry] = useState<SourceState>(EMPTY);
  const [now, setNow] = useState<number>(() => Date.now());

  // Hold the enabled sets so Refresh-all can re-fire without re-reading storage.
  const enabled = useRef<{ work: string[]; observe: string[] }>({ work: [], observe: [] });
  const grafanaCfg = useRef<{ baseUrl: string; token: string }>({ baseUrl: "", token: "" });
  const sentryCfg = useRef<{ baseUrl: string; org: string; project: string; token: string }>({
    baseUrl: "",
    org: "",
    project: "",
    token: ""
  });

  const refreshAll = useCallback(() => {
    if (enabled.current.work.length > 0) {
      void client.listWork(enabled.current.work).catch(() => undefined);
    }
    if (enabled.current.observe.includes("servicebus")) {
      void client.listServiceBus().catch(() => undefined);
    }
    if (enabled.current.observe.includes("grafana")) {
      void client
        .grafanaSummary(grafanaCfg.current.baseUrl, grafanaCfg.current.token)
        .catch(() => undefined);
    }
    if (enabled.current.observe.includes("sentry")) {
      void client.sentrySummary(sentryCfg.current).catch(() => undefined);
    }
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const stamp = Date.now();
      const payload = event.payload;
      if (payload.kind === "work_snapshot") {
        const count = payload.snapshot.sources.reduce((sum, s) => sum + (s.items?.length ?? 0), 0);
        setWork({ value: count, tone: "ok", updatedAt: stamp });
      } else if (payload.kind === "service_bus_snapshot") {
        if (payload.snapshot.available) {
          const dlq = payload.snapshot.namespaces
            .flatMap((ns) => ns.entities)
            .reduce((sum, e) => sum + e.deadLetter, 0);
          setServiceBus({ value: dlq, tone: attentionTone(dlq), updatedAt: stamp });
        } else {
          setServiceBus({ value: 0, tone: "muted", updatedAt: stamp, error: payload.snapshot.error ?? "unavailable" });
        }
      } else if (payload.kind === "grafana_summary") {
        if (payload.summary.available) {
          setGrafana({ value: payload.summary.dashboards.length, tone: "ok", updatedAt: stamp });
        } else {
          setGrafana({ value: 0, tone: "muted", updatedAt: stamp, error: payload.summary.error ?? "unavailable" });
        }
      } else if (payload.kind === "sentry_summary") {
        if (payload.summary.available) {
          const count = payload.summary.issues.length;
          setSentry({ value: count, tone: attentionTone(count), updatedAt: stamp });
        } else {
          setSentry({ value: 0, tone: "muted", updatedAt: stamp, error: payload.summary.error ?? "unavailable" });
        }
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      const prefs = loadConnectorPrefs();
      const config = loadConnectorConfig();
      enabled.current = {
        work: enabledIds(prefs, "work"),
        observe: enabledIds(prefs, "observability")
      };
      const g = getConnectorConfig(config, "grafana");
      grafanaCfg.current = { baseUrl: g.baseUrl ?? "", token: g.token ?? "" };
      const s = getConnectorConfig(config, "sentry");
      sentryCfg.current = {
        baseUrl: s.baseUrl ?? "",
        org: s.org ?? "",
        project: s.project ?? "",
        token: s.token ?? ""
      };
      setNow(Date.now());
      refreshAll();
    }
  }, [active, refreshAll]);

  // Keep the relative "updated" stamps fresh while the tab is open.
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  const cards = buildCards(enabled.current, { work, serviceBus, grafana, sentry });

  return (
    <section className="hub" aria-label="Hub">
      <header className="hub-header">
        <h2>Hub</h2>
        {cards.length > 0 && (
          <button type="button" onClick={refreshAll}>
            Refresh all
          </button>
        )}
      </header>
      <p className="hub-scope">Everything that needs your attention, at a glance.</p>

      {cards.length === 0 ? (
        <p className="hub-empty">
          No connectors enabled yet. Turn some on in <strong>Settings → Connectors</strong> to
          see your work and telemetry here.
        </p>
      ) : (
        <div className="hub-grid">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className={`hub-card tone-${card.state.tone}`}
              onClick={() => onNavigate(card.view)}
            >
              <span className="hub-card-label">{card.label}</span>
              <span className="hub-card-value">
                {card.state.error === undefined ? card.state.value : "-"}
              </span>
              <span className="hub-card-hint">
                {card.state.error ?? card.hint}
              </span>
              <span className="hub-card-updated">
                {card.state.updatedAt === undefined
                  ? "…"
                  : `updated ${formatRelative(now, card.state.updatedAt)}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

interface HubCard {
  id: string;
  label: string;
  hint: string;
  view: "work" | "observe";
  state: SourceState;
}

/** Build the card list from the enabled connectors + their latest state. */
function buildCards(
  enabled: { work: string[]; observe: string[] },
  states: { work: SourceState; serviceBus: SourceState; grafana: SourceState; sentry: SourceState }
): HubCard[] {
  const cards: HubCard[] = [];
  if (enabled.work.length > 0) {
    cards.push({ id: "work", label: "Assigned work", hint: "issues & PRs", view: "work", state: states.work });
  }
  if (enabled.observe.includes("servicebus")) {
    cards.push({
      id: "servicebus",
      label: "Dead-letter",
      hint: "messages across queues",
      view: "observe",
      state: states.serviceBus
    });
  }
  if (enabled.observe.includes("sentry")) {
    cards.push({
      id: "sentry",
      label: "Unresolved errors",
      hint: "open Sentry issues",
      view: "observe",
      state: states.sentry
    });
  }
  if (enabled.observe.includes("grafana")) {
    cards.push({
      id: "grafana",
      label: "Dashboards",
      hint: "in Grafana",
      view: "observe",
      state: states.grafana
    });
  }
  return cards;
}
