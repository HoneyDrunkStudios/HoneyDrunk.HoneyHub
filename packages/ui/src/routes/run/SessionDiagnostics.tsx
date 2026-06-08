import type {
  AgentBackend,
  DispatchMessage,
  UsageFidelity,
  UsageSignal
} from "@honeydrunk/honeyhub-types";
import { formatUsd } from "../../usageFormat";
import { computeSessionDiagnostics } from "./diagnosticsModel";

export interface SessionDiagnosticsProps {
  backend: AgentBackend;
  messages: DispatchMessage[];
  usage: UsageSignal[];
}

function formatUsdOrDash(usd: number | undefined, fidelity: UsageFidelity | undefined): string {
  return usd === undefined ? "—" : formatUsd(usd, fidelity);
}

function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? "—" : tokens.toLocaleString();
}

export function SessionDiagnostics({ backend, messages, usage }: SessionDiagnosticsProps) {
  const diagnostics = computeSessionDiagnostics({ backend, messages, usage });
  const elapsedMin =
    diagnostics.elapsedMs === undefined
      ? undefined
      : Math.round(diagnostics.elapsedMs / 60_000);

  return (
    <section className="diagnostics" aria-label="Session diagnostics">
      <header className="diagnostics-header">
        <h3>Diagnostics</h3>
        <span className={`health-pill health-${diagnostics.health.level}`}>
          {diagnostics.health.level === "good" ? "healthy" : "watch"}
        </span>
      </header>

      <dl className="diagnostics-grid">
        <div>
          <dt>Routed to</dt>
          <dd>
            {diagnostics.provider} · {diagnostics.model}
            {diagnostics.fidelity !== undefined && (
              <span className="fidelity-tag"> {diagnostics.fidelity}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Session usage</dt>
          <dd>
            {formatTokens(diagnostics.sessionTokens)} tok ·{" "}
            {formatUsdOrDash(diagnostics.sessionUsd, diagnostics.fidelity)}
          </dd>
        </div>
        <div>
          <dt>Last turn</dt>
          <dd>
            {formatTokens(diagnostics.lastTurnTokens)} tok ·{" "}
            {formatUsdOrDash(diagnostics.lastTurnUsd, diagnostics.fidelity)}
          </dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>
            {diagnostics.messageCount}
            {elapsedMin !== undefined && ` · ~${elapsedMin} min`}
          </dd>
        </div>
      </dl>

      {diagnostics.health.recommendations.length > 0 && (
        <ul className="diagnostics-recs" aria-label="Recommendations">
          {diagnostics.health.recommendations.map((recommendation) => (
            <li key={recommendation}>{recommendation}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
