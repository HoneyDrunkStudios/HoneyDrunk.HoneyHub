import { useState } from "react";
import type { ReactElement } from "react";
import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";
import { NumberField } from "../../components/NumberField";
import { isGoalActive, type Goal } from "./goalsModel";
import type { GoalStartInput } from "./goalOrchestrator";

export interface GoalsViewProps {
  /** Goals newest-first (active before terminal). */
  goals: Goal[];
  /** Backends the user may launch on. */
  backends: AgentBackend[];
  onCreate: (input: GoalStartInput) => void;
  onPause: (goalId: string) => void;
  onResume: (goalId: string) => void;
  onStop: (goalId: string) => void;
}

const STATE_LABEL: Record<Goal["state"], string> = {
  running: "Running",
  paused: "Paused",
  needs_input: "Needs input",
  completed: "Done",
  stopped: "Stopped",
  failed: "Failed"
};

/**
 * Goals (control-hub roadmap #5): a bounded orchestration loop. You give an objective and
 * caps (a max number of iterations and an optional spend ceiling); HoneyHub launches a run
 * toward it and keeps re-running — each iteration a follow-up carrying the prior transcript
 * — until a cap is reached, you stop/pause it, or a run needs input. Every iteration shows
 * on the Runs board. There is no automated "is it done?" judge, so the caps are the bound.
 */
export function GoalsView({
  goals,
  backends,
  onCreate,
  onPause,
  onResume,
  onStop
}: Readonly<GoalsViewProps>): ReactElement {
  return (
    <section className="goals" aria-label="Goals">
      <header className="goals-header">
        <h2>Goals</h2>
      </header>
      <p className="goals-scope">
        Give an objective and caps; HoneyHub runs a bounded loop toward it, one iteration per
        run, and stops at the limit. Each run appears on the Runs board. There is no
        automatic “done” detector: the caps and your stop control are the bound.
      </p>

      <NewGoalForm backends={backends} onCreate={onCreate} />

      {goals.length === 0 ? (
        <p className="goals-empty">No goals yet. Create one above to start a loop.</p>
      ) : (
        <ul className="goals-list">
          {goals.map((goal) => (
            <li key={goal.id} className={`goal-card state-${goal.state}`}>
              <div className="goal-card-head">
                <span className="goal-objective">{goal.objective}</span>
                <span className={`goal-state pill-${goal.state}`}>{STATE_LABEL[goal.state]}</span>
              </div>
              <div className="goal-meta">
                <span>{backendLabel(goal.backend)}</span>
                {goal.model !== undefined && <span className="goal-model">{goal.model}</span>}
                <span>
                  iteration {goal.iterations}/{goal.maxIterations}
                </span>
                <span>${goal.totalUsd.toFixed(4)}</span>
                {goal.spendCapUsd !== undefined && (
                  <span className="goal-cap">cap ${goal.spendCapUsd.toFixed(2)}</span>
                )}
              </div>
              {goal.note !== undefined && <p className="goal-note">{goal.note}</p>}
              <div className="goal-actions">
                {goal.state === "running" && (
                  <button type="button" onClick={() => onPause(goal.id)}>
                    Pause
                  </button>
                )}
                {goal.state === "paused" && (
                  <button type="button" onClick={() => onResume(goal.id)}>
                    Resume
                  </button>
                )}
                {isGoalActive(goal) && (
                  <button type="button" className="goal-stop" onClick={() => onStop(goal.id)}>
                    Stop
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface NewGoalFormProps {
  backends: AgentBackend[];
  onCreate: (input: GoalStartInput) => void;
}

function NewGoalForm({ backends, onCreate }: Readonly<NewGoalFormProps>): ReactElement {
  const [objective, setObjective] = useState("");
  const [backend, setBackend] = useState<AgentBackend>(backends[0] ?? "claude.local");
  const [maxIterations, setMaxIterations] = useState("1");
  const [spendCap, setSpendCap] = useState("");

  const iterations = Math.max(1, Math.floor(Number(maxIterations) || 1));
  const cap = spendCap.trim().length > 0 ? Number(spendCap) : undefined;
  const capValid = cap === undefined || (Number.isFinite(cap) && cap > 0);
  const canSubmit = objective.trim().length > 0 && capValid;

  return (
    <form
      className="goal-form"
      aria-label="New goal"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) {
          return;
        }
        onCreate({
          objective: objective.trim(),
          backend,
          maxIterations: iterations,
          ...(cap === undefined ? {} : { spendCapUsd: cap })
        });
        setObjective("");
        setSpendCap("");
        setMaxIterations("1");
      }}
    >
      <label>
        Objective{" "}
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          rows={3}
          placeholder="e.g. Get the test suite green and open a PR."
        />
      </label>
      <div className="goal-form-row">
        <label>
          Provider{" "}
          <select value={backend} onChange={(event) => setBackend(event.target.value as AgentBackend)}>
            {backends.map((option) => (
              <option key={option} value={option}>
                {backendLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max iterations{" "}
          <NumberField min={1} value={maxIterations} onChange={setMaxIterations} ariaLabel="Max iterations" />
        </label>
        <label>
          Spend cap (USD, optional){" "}
          <NumberField
            min={0}
            value={spendCap}
            onChange={setSpendCap}
            placeholder="none"
            ariaLabel="Spend cap (USD, optional)"
          />
        </label>
      </div>
      {!capValid && <p className="goal-form-hint">Spend cap must be a positive amount.</p>}
      <button type="submit" disabled={!canSubmit}>
        Start goal
      </button>
    </form>
  );
}
