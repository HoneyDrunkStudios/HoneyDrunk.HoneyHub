import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement, SyntheticEvent } from "react";
import type { JobProbe, JobSnapshot } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { filterProcesses, formatMemoryKb, runningCount } from "./jobsModel";
import { addProbe, loadJobPatterns, removeProbe, saveJobPatterns } from "./jobPatterns";

export interface JobsViewProps {
  client: WireClient;
  /** The parent toggles this so a hidden tab makes no host requests. */
  active: boolean;
}

/**
 * Local Jobs (control-hub roadmap #7): a read-only, **agent-focused** snapshot — the curated
 * dev tools + local runner ("known jobs"), the processes that belong to them, and the
 * agent-related Windows Scheduled Tasks (not every system process/task). Matched by image
 * name + command line, so the Grid runner is recognized by its script even under PowerShell.
 * A "How it works" panel onboards a new user. Asks the host to snapshot when the tab becomes
 * active and listens for the `job_snapshot` event.
 */
export function JobsView({ client, active }: Readonly<JobsViewProps>): ReactElement {
  const [snapshot, setSnapshot] = useState<JobSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  // The user's configurable job patterns (persisted locally, merged onto the built-ins by
  // the host on every snapshot request).
  const [userProbes, setUserProbes] = useState<JobProbe[]>(() => loadJobPatterns());

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    const options = userProbes.length > 0 ? { extraProbes: userProbes } : undefined;
    client.listJobs(options).catch(() => {
      setError("could not read local jobs");
      setLoading(false);
    });
  }, [client, userProbes]);

  const persistProbes = useCallback((next: JobProbe[]) => {
    setUserProbes(next);
    saveJobPatterns(next);
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "job_snapshot") {
        setSnapshot(event.payload.snapshot);
        setLoading(false);
        setError(undefined);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh]);

  const processes = useMemo(
    () => (snapshot === undefined ? [] : filterProcesses(snapshot.processes, query)),
    [snapshot, query]
  );

  return (
    <section className="jobs" aria-label="Jobs">
      <header className="jobs-header">
        <h2>Local jobs</h2>
        <div className="jobs-actions">
          <button type="button" onClick={() => setShowHelp((open) => !open)}>
            {showHelp ? "Hide help" : "How it works"}
          </button>
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </header>
      <p className="jobs-scope">
        Your agent jobs: the dev tools and runner HoneyHub watches, not every process on the
        machine. Read-only; matched by program name + command line, so the Grid runner is
        recognized by its script even when it runs under PowerShell.
      </p>

      {showHelp && (
        <JobsHelp
          userProbes={userProbes}
          onAdd={(label, patterns) => persistProbes(addProbe(userProbes, label, patterns))}
          onRemove={(label) => persistProbes(removeProbe(userProbes, label))}
        />
      )}

      {error !== undefined && (
        <p role="alert" className="jobs-error">
          {error}
        </p>
      )}

      {snapshot === undefined ? (
        <p className="jobs-empty">{loading ? "Reading local jobs…" : "No snapshot yet."}</p>
      ) : (
        <>
          {runningCount(snapshot) === 0 && snapshot.scheduled.length === 0 && (
            <p className="jobs-empty-hint">
              No agent jobs are running right now. New here?{" "}
              <button type="button" className="link-button" onClick={() => setShowHelp(true)}>
                See how it works
              </button>{" "}
              to set them up.
            </p>
          )}
          <div className="jobs-known-head">
            <h3>Known jobs</h3>
            <span className="jobs-tally">
              {runningCount(snapshot)}/{snapshot.known.length} up
            </span>
          </div>
          <ul className="jobs-known">
            {snapshot.known.map((job) => (
              <li key={job.label} className={`known-job ${job.running ? "is-up" : "is-down"}`}>
                <span className="known-dot" aria-hidden="true" />
                <span className="known-label">{job.label}</span>
                <span className="known-status">{job.running ? "Running" : "Not running"}</span>
                {job.running && (
                  <span className="known-meta">
                    {job.instances}× · {formatMemoryKb(job.memoryKb)}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {snapshot.scheduled.length > 0 && (
            <>
              <div className="jobs-proc-head">
                <h3>Scheduled tasks</h3>
              </div>
              <ul className="jobs-scheduled">
                {snapshot.scheduled.map((task) => {
                  const failed = task.lastResult !== undefined && task.lastResult !== 0;
                  const resultLabel = failed
                    ? `last: error ${task.lastResult}`
                    : "last: ok";
                  return (
                    <li
                      key={`${task.path}${task.name}`}
                      className={`scheduled-task ${failed ? "is-failed" : ""} state-${task.state.toLowerCase()}`}
                    >
                      <span className="scheduled-name">{task.name}</span>
                      <span className="scheduled-state">{task.state}</span>
                      <span className="scheduled-result">
                        {task.lastResult === undefined ? "-" : resultLabel}
                      </span>
                      {task.nextRun !== undefined && (
                        <span className="scheduled-next" title={task.nextRun}>
                          next {task.nextRun.slice(0, 16).replace("T", " ")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <div className="jobs-proc-head">
            <h3>Agent processes</h3>
            <input
              className="jobs-search"
              type="search"
              aria-label="Filter processes"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name…"
            />
          </div>
          <table className="jobs-table">
            <thead>
              <tr>
                <th scope="col">Process</th>
                <th scope="col">PID</th>
                <th scope="col">Memory</th>
                <th scope="col">Command</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((process) => (
                <tr key={`${process.pid}-${process.name}`}>
                  <td>{process.name}</td>
                  <td className="jobs-pid">{process.pid}</td>
                  <td className="jobs-mem">{formatMemoryKb(process.memoryKb)}</td>
                  <td className="jobs-cmd" title={process.command ?? ""}>
                    {process.command ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {processes.length === 0 && (
            <p className="jobs-empty">
              {query.trim() === ""
                ? "No agent processes are running right now."
                : `No agent processes match “${query}”.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

interface JobsHelpProps {
  userProbes: JobProbe[];
  onAdd: (label: string, patterns: string) => void;
  onRemove: (label: string) => void;
}

/** Onboarding panel: what the Jobs screen watches, how a new user makes their own background
    jobs show up (the naming convention + a concrete schtasks example), and a form to add
    custom job patterns (matched against process name + command line). */
function JobsHelp({ userProbes, onAdd, onRemove }: Readonly<JobsHelpProps>): ReactElement {
  const [label, setLabel] = useState("");
  const [patterns, setPatterns] = useState("");

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (label.trim() === "" || patterns.trim() === "") {
      return;
    }
    onAdd(label, patterns);
    setLabel("");
    setPatterns("");
  };

  return (
    <div className="jobs-help">
      <p className="jobs-help-title">What this shows</p>
      <p>
        HoneyHub watches the agent &amp; dev tools running on this machine and your
        agent-related scheduled tasks; it doesn&rsquo;t list every process. A job is
        &ldquo;up&rdquo; when a matching process is running.
      </p>
      <p className="jobs-help-title">Auto-recognized</p>
      <p className="jobs-help-tags">
        Claude Code · Codex · Node · cargo / rustc · git · the Grid agent runner · HoneyHub
        itself
      </p>

      <p className="jobs-help-title">Add your own job pattern</p>
      <p>
        Track another process by what it runs. The pattern is matched against each
        process&rsquo;s <strong>name and command line</strong> (case-insensitive), so a path
        fragment recognizes a job even when it runs under a generic host like PowerShell.
        Comma-separate multiple patterns.
      </p>
      <form className="jobs-probe-form" onSubmit={submit}>
        <label className="jobs-probe-field">
          <span>Label</span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="My worker"
          />
        </label>
        <label className="jobs-probe-field">
          <span>Patterns</span>
          <input
            type="text"
            value={patterns}
            onChange={(event) => setPatterns(event.target.value)}
            placeholder="my-worker, queue-runner.js"
          />
        </label>
        <button type="submit" disabled={label.trim() === "" || patterns.trim() === ""}>
          Add job
        </button>
      </form>
      {userProbes.length > 0 && (
        <ul className="jobs-probe-list">
          {userProbes.map((probe) => (
            <li key={probe.label} className="jobs-probe-row">
              <span className="jobs-probe-label">{probe.label}</span>
              <span className="jobs-probe-patterns">{probe.patterns.join(", ")}</span>
              <button
                type="button"
                className="link-button"
                onClick={() => onRemove(probe.label)}
                aria-label={`Remove ${probe.label}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="jobs-help-title">Add a scheduled background job</p>
      <p>
        Create a Windows Scheduled Task whose <strong>name or script path</strong> contains
        one of <code>grid-agent-runner</code>, <code>honeydrunk</code>, <code>honeyhub</code>,{" "}
        <code>claude</code>, or <code>codex</code>, and it will then appear here with its state
        and last result. For example, a daily agent run:
      </p>
      <pre className="jobs-help-code">
{String.raw`schtasks /create /tn "honeydrunk-nightly" \
  /tr "powershell -NoProfile -File C:\path\to\run.ps1" \
  /sc daily /st 02:00`}
      </pre>
      <p className="jobs-help-note">
        Read-only: HoneyHub never starts, stops, or edits these; it only shows their status.
      </p>
    </div>
  );
}
