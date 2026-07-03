import type {
  AgentBackend,
  AgentDefinition,
  BackendCapability,
  BridgeEvent,
  BridgeEventPayload,
  DirListing,
  DispatchRunState,
  FileContents,
  ExpiringObject,
  JobProbe,
  KeyVault,
  PolicyHint,
  SecretReveal,
  StartRunRequest,
  UsageSignal,
  VaultObject,
  WorkSource
} from "@honeydrunk/honeyhub-types";
import {
  defaultClaudeCapabilities,
  defaultCodexCapabilities
} from "@honeydrunk/honeyhub-types";
import { summarizeUsage } from "../routes/spend/spendModel";
import type { StartedRun, WireClient, WireEventHandler } from "./client";

// An in-memory wire client that scripts a realistic Claude Code exchange:
// start -> stream -> needs_input -> (reply) -> usage + PR artifact -> completed,
// and stop -> stopping -> cancelled. It backs the offline demo and the RTL test;
// the real WebSocket client implements the same `WireClient` seam later.

// mock-only sample addresses (scripted offline "Connect a phone" surface; not real hosts).
// Assembled from octet parts so they read as obviously-fake demo data rather than a real host.
const MOCK_TAILNET_ADDRESS = [100, 110, 120, 130].join(".");
const MOCK_LAN_ADDRESS = [192, 168, 1, 42].join(".");

// mock-only sample Azure ids (scripted offline Key Vault surface; obviously-fake demo data).
export const MOCK_SUBSCRIPTION_DEV = "00000000-0000-0000-0000-0000000000de";
const MOCK_SUBSCRIPTION_PROD = "00000000-0000-0000-0000-0000000000d0";
const MOCK_SUBSCRIPTION_LOCKED = "00000000-0000-0000-0000-0000000010c0";
const MOCK_TENANT = "00000000-0000-0000-0000-00000000beef";

interface MockState {
  sessionId: string;
  backend: AgentBackend;
}

export class MockWireClient implements WireClient {
  private readonly handlers = new Set<WireEventHandler>();
  private sequence = 0;
  // Test hook: when set, `revealSecret` queues responses instead of emitting them, so a test can
  // simulate a slow/out-of-order reveal and release it later via `flushReveals()`.
  public deferReveals = false;
  private deferredReveals: SecretReveal[] = [];
  private readonly runs = new Map<string, MockState>();
  private readonly createdAt = "2026-06-07T12:00:00.000Z";
  // Accumulate the usage the demo emits so `requestUsageSummary` can roll it up the
  // same way the real host does (mirroring `UsageSummary::from_signals`).
  private readonly usageSignals: UsageSignal[] = [];
  private readonly sessionIds = new Set<string>();

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(sessionId: string, runId: string, payload: BridgeEventPayload): void {
    if (payload.kind === "usage") {
      this.usageSignals.push(payload.signal);
    }
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId,
      runId,
      sequence: this.sequence,
      createdAt: this.createdAt,
      payload
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private status(sessionId: string, runId: string, backend: AgentBackend, state: DispatchRunState) {
    this.emit(sessionId, runId, { kind: "status", status: { state, backend } });
  }

  private message(
    sessionId: string,
    runId: string,
    body: string,
    isPartial: boolean
  ): void {
    this.emit(sessionId, runId, {
      kind: "message",
      message: {
        id: `message-${this.sequence}`,
        sessionId,
        runId,
        role: "agent",
        body,
        createdAt: this.createdAt,
        isPartial
      }
    });
  }

  async start(request: StartRunRequest): Promise<StartedRun> {
    const runId = request.requestedRunId ?? `run-${this.runs.size + 1}`;
    const sessionId = request.session.id;
    const backend = request.session.backend;
    this.runs.set(runId, { sessionId, backend });
    this.sessionIds.add(sessionId);

    this.status(sessionId, runId, backend, "running");
    this.message(sessionId, runId, "Reading the workspace", true);
    this.message(sessionId, runId, "I can take that on. Which file should I change?", false);
    this.status(sessionId, runId, backend, "needs_input");

    return { runId };
  }

  async reply(runId: string, _text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`unknown run ${runId}`);
    }
    const { sessionId, backend } = run;

    this.status(sessionId, runId, backend, "running");
    // Tool/file activity, so the right-panel activity stream is exercisable offline.
    this.emit(sessionId, runId, {
      kind: "activity",
      activity: {
        id: `activity-${this.sequence}`,
        sessionId,
        runId,
        kind: "read",
        label: "Read",
        detail: "README.md",
        createdAt: this.createdAt
      }
    });
    this.emit(sessionId, runId, {
      kind: "activity",
      activity: {
        id: `activity-${this.sequence}`,
        sessionId,
        runId,
        kind: "edit",
        label: "Edit",
        detail: "src/app.ts",
        createdAt: this.createdAt
      }
    });
    this.message(sessionId, runId, "Applying the change", true);
    this.message(sessionId, runId, "Done. Opened a pull request.", false);
    this.emit(sessionId, runId, {
      kind: "usage",
      signal: {
        id: `usage-${this.sequence}`,
        sessionId,
        runId,
        backend,
        fidelity: "exact",
        modelLabel: "claude",
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        totalUsd: 0.0182,
        recordedAt: this.createdAt
      }
    });
    this.emit(sessionId, runId, {
      kind: "artifact",
      artifact: {
        id: `artifact-${this.sequence}`,
        sessionId,
        runId,
        kind: "pull_request",
        label: "Open PR",
        href: "https://example.test/pr/1",
        createdAt: this.createdAt
      }
    });
    this.status(sessionId, runId, backend, "finalizing");
    this.status(sessionId, runId, backend, "completed");
  }

  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new Error(`unknown run ${runId}`);
    }
    const { sessionId, backend } = run;
    this.status(sessionId, runId, backend, "stopping");
    this.status(sessionId, runId, backend, "cancelled");
  }

  async requestUsageSummary(): Promise<void> {
    // The host answers a usage-summary query with a device-wide event; the mock
    // rolls up the usage it has emitted so far through the same aggregator the UI
    // ships, and surfaces it as a `usage_summary` event (session/run ids empty,
    // matching the bridge's device-scoped event).
    const summary = summarizeUsage(this.usageSignals, this.sessionIds.size);
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      // Device-scoped event: sequence is 0 to match the bridge's
      // `BridgeEvent::usage_summary` contract (it is not part of any run's ordered
      // stream). The id still uses the counter so it stays unique.
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "usage_summary", summary }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async requestCoachingHints(): Promise<void> {
    // The real host runs the Rust coaching engine over EVERY session; the offline
    // mock can't, so it surfaces a small set of *scripted demo* advisories for each
    // session it has seen — enough to exercise the cross-session surface (ordering,
    // multiple sessions) without re-implementing the engine. With no session yet, it
    // returns none (honest empty state).
    const hints: PolicyHint[] = [...this.sessionIds].flatMap((sessionId) => [
      {
        id: `coach:${sessionId}:stale_session`,
        sessionId,
        code: "stale_session",
        severity: "warning" as const,
        message:
          "This session has grown large. Starting a fresh session keeps the agent focused and can respond faster and cost less.",
        createdAt: this.createdAt
      },
      {
        id: `coach:${sessionId}:estimate_only_spend`,
        sessionId,
        code: "estimate_only_spend",
        severity: "info" as const,
        message:
          "Some usage for this session is estimated, so the spend figures shown are approximate rather than exact.",
        createdAt: this.createdAt
      }
    ]);
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "coaching_hints", hints }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async discoverAgents(_workspaceRoot?: string): Promise<void> {
    // The real host scans the filesystem; the mock returns a small *scripted demo*
    // catalog so the Agents surface is exercised offline: one Claude subagent runnable
    // on both Claude and Copilot (the multi-backend, one-entry-per-name shape), and one
    // global Copilot agent.
    // A fixed scripted-demo label (the host derives one from the root's basename or a
    // hash; the mock keeps it constant so it never diverges for a rootless root).
    const label = "demo";
    // Fixed opaque demo ids. The real host derives the id by FNV-hashing the agent name;
    // the mock just hard-codes distinct 16-hex constants (it isn't a hash of these names)
    // so the offline catalog is stable without reimplementing the host's hash.
    const agents: AgentDefinition[] = [
      {
        id: "00000000000000a1",
        name: "Code Reviewer",
        backends: [
          {
            backend: "claude.local",
            description: "Reviews a diff against the Grid invariants before a PR.",
            model: "claude-opus",
            sourcePath: ".claude/agents/code-reviewer.md",
            scope: "project",
            workspaceLabel: label
          },
          {
            backend: "copilot.local",
            description: "Reviews a diff before a PR.",
            sourcePath: ".copilot/agents/code-reviewer.md",
            scope: "project",
            workspaceLabel: label
          }
        ]
      },
      {
        id: "00000000000000b2",
        name: "release agent",
        backends: [
          {
            backend: "copilot.local",
            description: "Drafts release notes from merged PRs.",
            sourcePath: ".copilot/agents/release-agent.md",
            scope: "global",
            workspaceLabel: "global"
          }
        ]
      }
    ];
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "agent_catalog", agents }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async discoverBackends(): Promise<void> {
    // The real host probes PATH; the offline mock scripts a catalog where only
    // Claude is "installed" (the demo backend), so the first-run picker has a
    // realistic detected/not-found split without touching the machine.
    const backends: BackendCapability[] = [
      {
        backend: "claude.local",
        program: "claude",
        available: true,
        capabilities: defaultClaudeCapabilities,
        // Mirrors the bridge's curated Claude catalog (crates/bridge/src/
        // backend_catalog.rs models_for) — labels and metering must track that
        // source of truth. No rates here (invariant 45): pricing only ever comes
        // from the operator's HONEYHUB_MODEL_RATES table, so the mock carries none.
        models: [
          { id: "opus", label: "Claude Opus 4.8" },
          { id: "sonnet", label: "Claude Sonnet 5" },
          { id: "haiku", label: "Claude Haiku 4.5" },
          { id: "fable", label: "Claude Fable 5", metered: true }
        ],
        modelSource: "cli_alias"
      },
      {
        backend: "codex.local",
        program: "codex",
        available: false,
        capabilities: defaultCodexCapabilities,
        models: [
          { id: "gpt-5.5", label: "GPT-5.5" },
          { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" }
        ],
        modelSource: "cli_cache"
      }
    ];
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload: { kind: "backend_catalog", backends }
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  async setWorkspaceRoots(_roots: string[]): Promise<void> {
    // The mock has no real allowlist to update; accept silently (the host enforces it).
  }

  async browseDir(path = ""): Promise<void> {
    // A tiny scripted tree so the offline picker/browser is exercisable without disk.
    const tree: Record<string, DirListing> = {
      "": {
        path: "",
        entries: [{ name: "/demo", kind: "dir" }],
        truncated: false
      },
      "/demo": {
        path: "/demo",
        parent: "",
        entries: [
          { name: "HoneyHub", kind: "dir" },
          { name: "demo.code-workspace", kind: "file", size: 96 }
        ],
        truncated: false
      },
      "/demo/HoneyHub": {
        path: "/demo/HoneyHub",
        parent: "/demo",
        entries: [
          { name: "src", kind: "dir" },
          { name: "README.md", kind: "file", size: 64 }
        ],
        truncated: false
      },
      "/demo/HoneyHub/src": {
        path: "/demo/HoneyHub/src",
        parent: "/demo/HoneyHub",
        entries: [{ name: "main.ts", kind: "file", size: 32 }],
        truncated: false
      }
    };
    const listing = tree[path] ?? { path, parent: "", entries: [], truncated: false };
    this.emitDevice({ kind: "dir_listing", listing });
  }

  async readFile(path: string): Promise<void> {
    const files: Record<string, string> = {
      "/demo/HoneyHub/README.md": "# HoneyHub\n\nA scripted demo readme.\n",
      "/demo/HoneyHub/src/main.ts": "export const greeting = \"hello\";\n"
    };
    const content = files[path] ?? "// (demo) no scripted content for this file\n";
    const file: FileContents = {
      path,
      content,
      truncated: false,
      byteSize: content.length
    };
    this.emitDevice({ kind: "file_contents", file });
  }

  async searchFiles(root: string, query: string): Promise<void> {
    const all = [
      "/demo/HoneyHub/README.md",
      "/demo/HoneyHub/src/main.ts"
    ];
    const needle = query.trim().toLowerCase();
    const hits = needle.length === 0
      ? []
      : all
          .filter((path) => path.toLowerCase().includes(needle))
          .map((path) => ({ path, name: path.split("/").pop() ?? path }));
    this.emitDevice({
      kind: "search_results",
      results: { root, query, hits, truncated: false }
    });
  }

  async resolveWorkspaceFile(path: string): Promise<void> {
    // The scripted demo workspace points at the one demo repo.
    this.emitDevice({
      kind: "workspace_folders",
      folders: { workspaceFile: path, folders: ["/demo/HoneyHub"] }
    });
  }

  async writeAgent(input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    workspaceRoot?: string;
  }): Promise<void> {
    // The mock writes nothing to disk; it echoes the authored agent back as the host
    // would, so the Agents surface can confirm + re-discover offline.
    this.emitDevice({
      kind: "agent_written",
      agent: {
        name: input.name,
        sourcePath: `.claude/agents/${input.name}.md`,
        scope: input.workspaceRoot === undefined ? "global" : "project"
      }
    });
  }

  async gitStatus(root: string): Promise<void> {
    // The real host shells out to git; the mock scripts a dirty repo so the Git surface is
    // exercisable offline.
    this.emitDevice({
      kind: "git_status",
      status: {
        root,
        branch: "feat/honeyhub-desktop-shell",
        upstream: "origin/feat/honeyhub-desktop-shell",
        ahead: 2,
        behind: 0,
        files: [
          { path: "packages/ui/src/App.tsx", status: " M", staged: false, untracked: false },
          { path: "notes.md", status: "??", staged: false, untracked: true }
        ],
        clean: false
      }
    });
  }

  async gitDiff(root: string, path?: string): Promise<void> {
    const patch =
      "diff --git a/packages/ui/src/App.tsx b/packages/ui/src/App.tsx\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-const view = \"run\";\n" +
      "+const view = \"chat\";\n" +
      " // unchanged line\n";
    this.emitDevice({
      kind: "git_diff",
      diff: { root, ...(path === undefined ? {} : { path }), patch, truncated: false }
    });
  }

  /** A scripted single-repo status (dirty by default) for the offline Git demo. */
  private mockGitStatus(root: string, dirty = true) {
    return {
      root,
      branch: "feat/honeyhub-desktop-shell",
      upstream: "origin/feat/honeyhub-desktop-shell",
      ahead: 2,
      behind: 0,
      files: dirty
        ? [
            { path: "packages/ui/src/App.tsx", status: " M", staged: false, untracked: false },
            { path: "notes.md", status: "??", staged: false, untracked: true }
          ]
        : [],
      clean: !dirty
    };
  }

  async gitOverview(root: string): Promise<void> {
    // The real host discovers repos under the folder; the mock scripts two so the multi-repo
    // dashboard is exercisable offline (one dirty, one clean).
    const sep = root.includes("\\") ? "\\" : "/";
    this.emitDevice({
      kind: "git_overview",
      overview: {
        root,
        repos: [
          this.mockGitStatus(`${root}${sep}HoneyHub`, true),
          this.mockGitStatus(`${root}${sep}HoneyDrunk.AI`, false)
        ]
      }
    });
  }

  async gitBranches(root: string): Promise<void> {
    this.emitDevice({
      kind: "git_branches",
      branches: { root, current: "feat/honeyhub-desktop-shell", branches: ["main", "feat/honeyhub-desktop-shell"] }
    });
  }

  /** Emit a write op's result + a fresh status, mirroring the host. `nowClean` reflects ops
      that leave the tree clean (commit/discard) so the demo updates believably. */
  private emitGitWrite(root: string, op: string, message: string, nowClean: boolean): void {
    this.emitDevice({ kind: "git_op", result: { root, op, ok: true, message } });
    this.emitDevice({ kind: "git_status", status: this.mockGitStatus(root, !nowClean) });
  }

  async gitStage(root: string, _paths: string[]): Promise<void> {
    this.emitGitWrite(root, "stage", "(demo) staged", false);
  }

  async gitUnstage(root: string, _paths: string[]): Promise<void> {
    this.emitGitWrite(root, "unstage", "(demo) unstaged", false);
  }

  async gitCommit(root: string, _message: string): Promise<void> {
    this.emitGitWrite(root, "commit", "(demo) 1 file changed", true);
  }

  async gitPush(root: string): Promise<void> {
    this.emitGitWrite(root, "push", "(demo) pushed to origin", false);
  }

  async gitPull(root: string): Promise<void> {
    this.emitGitWrite(root, "pull", "(demo) Already up to date.", false);
  }

  async gitCheckout(root: string, name: string, _create?: boolean): Promise<void> {
    this.emitGitWrite(root, "checkout", `(demo) switched to ${name}`, false);
  }

  async gitDiscard(root: string, _paths: string[], _untracked?: boolean): Promise<void> {
    this.emitGitWrite(root, "discard", "(demo) discarded changes", true);
  }

  async gitDiscardAll(root: string): Promise<void> {
    this.emitGitWrite(root, "discard", "(demo) discarded all changes", true);
  }

  async gitDeleteBranch(root: string, name: string, _force?: boolean): Promise<void> {
    this.emitGitWrite(root, "delete-branch", `(demo) deleted ${name}`, false);
  }

  async listSessions(): Promise<void> {
    // The real host reads the LocalStore; the mock scripts one durable past session so the
    // synced-history surface is exercisable offline.
    this.emitDevice({
      kind: "session_list",
      sessions: [
        {
          id: "sess-past-1",
          backend: "claude.local",
          title: "Wire the deploy triggers",
          workspaceRoot: "/demo/HoneyHub",
          createdAt: this.createdAt,
          updatedAt: this.createdAt
        }
      ]
    });
  }

  async sessionDetail(sessionId: string): Promise<void> {
    this.emitDevice({
      kind: "session_detail",
      sessionId,
      runs: [
        {
          id: "run-past-1",
          sessionId,
          state: "completed",
          task: "",
          startedAt: this.createdAt,
          completedAt: this.createdAt
        }
      ],
      transcript: [
        {
          id: "m-past-1",
          sessionId,
          runId: "run-past-1",
          role: "user",
          body: "Wire the deploy triggers",
          createdAt: this.createdAt
        },
        {
          id: "m-past-2",
          sessionId,
          runId: "run-past-1",
          role: "agent",
          body: "Done. Staged the workflow and opened a PR.",
          createdAt: this.createdAt
        }
      ]
    });
  }

  async roadmap(): Promise<void> {
    // The real host parses an Architecture repo; the mock scripts a found snapshot with the
    // three lanes so the Plan surface is exercisable offline.
    this.emitDevice({
      kind: "roadmap",
      roadmap: {
        found: true,
        source: "/demo/HoneyDrunk.Architecture/initiatives/current-focus.md",
        lastReviewed: "2026-06-13",
        lanes: [
          {
            lane: "HoneyHub",
            items: [
              {
                rank: 1,
                lane: "HoneyHub",
                item: "Launch checkpoint",
                kind: "initiative",
                status: "In progress",
                phase: "Wave 2",
                due: "2026-06-23"
              },
              {
                rank: 2,
                lane: "HoneyHub",
                item: "Public release + demo",
                kind: "initiative",
                status: "In progress",
                phase: "Wave 3",
                due: "2026-07-15",
                blockedBy: "#1"
              }
            ],
            next: {
              rank: 1,
              lane: "HoneyHub",
              item: "Launch checkpoint",
              kind: "initiative",
              status: "In progress",
              phase: "Wave 2",
              due: "2026-06-23"
            }
          },
          {
            lane: "NovOutbox",
            items: [
              {
                rank: 3,
                lane: "NovOutbox",
                item: "Go/slip decision",
                kind: "initiative",
                status: "In progress",
                phase: "Wave 2",
                due: "2026-06-23"
              }
            ],
            next: {
              rank: 3,
              lane: "NovOutbox",
              item: "Go/slip decision",
              kind: "initiative",
              status: "In progress",
              phase: "Wave 2",
              due: "2026-06-23"
            }
          },
          {
            lane: "Curiosities",
            items: [
              {
                rank: 10,
                lane: "Curiosities",
                item: "Phase 0 content spike",
                kind: "packet",
                status: "Proposed",
                phase: "Phase 0",
                due: "2026-08-15"
              }
            ],
            next: {
              rank: 10,
              lane: "Curiosities",
              item: "Phase 0 content spike",
              kind: "packet",
              status: "Proposed",
              phase: "Phase 0",
              due: "2026-08-15"
            }
          }
        ]
      }
    });
  }

  async scaffoldArchitecture(_input: { name?: string; location?: string }): Promise<void> {
    // The mock writes nothing to disk; it echoes a freshly-created starter roadmap (the
    // Example lane) so the empty-state create flow is exercisable offline.
    this.emitDevice({
      kind: "roadmap",
      roadmap: {
        found: true,
        source: "(scaffolded) architecture/initiatives/current-focus.md",
        lanes: [
          {
            lane: "Example",
            items: [
              {
                rank: 1,
                lane: "Example",
                item: "Replace this with your first real priority",
                kind: "task",
                status: "Planned",
                phase: "-",
                due: "-"
              }
            ],
            next: {
              rank: 1,
              lane: "Example",
              item: "Replace this with your first real priority",
              kind: "task",
              status: "Planned",
              phase: "-",
              due: "-"
            }
          }
        ]
      }
    });
  }

  async pullArchitecture(): Promise<void> {
    // The mock has no git remote; re-emit the scripted roadmap as a "pulled" refresh.
    return this.roadmap();
  }

  async runCheck(root: string, checkId: string): Promise<void> {
    // The mock doesn't run a process; script a passing check so the Groups "Run checks"
    // flow is exercisable offline.
    this.emitDevice({
      kind: "check_result",
      result: {
        root,
        check: checkId,
        command: checkId,
        ok: true,
        disposition: "ran",
        exitCode: 0,
        output: `(demo) ${checkId} passed`,
        truncated: false
      }
    });
  }

  async detectEnvironment(): Promise<void> {
    // The real host runs `<cli> --version`; the mock scripts Claude installed with a
    // version and Codex not installed, so the Updates surface is exercisable offline.
    this.emitDevice({
      kind: "environment_info",
      environment: {
        backends: [
          { backend: "claude.local", program: "claude", available: true, version: "1.4.0" },
          { backend: "codex.local", program: "codex", available: false }
        ]
      }
    });
  }

  async listNetwork(): Promise<void> {
    // The real host enumerates the OS network interfaces; the mock scripts a tailnet + LAN
    // address so the "Connect a phone" surface is exercisable offline.
    this.emitDevice({
      kind: "network_info",
      network: {
        addresses: [
          { ip: MOCK_TAILNET_ADDRESS, kind: "tailnet", interface: "Tailscale" },
          { ip: MOCK_LAN_ADDRESS, kind: "lan", interface: "Wi-Fi" }
        ]
      }
    });
  }

  async listWork(sources: string[]): Promise<void> {
    // The real host shells `gh`/`az`; the mock scripts a small snapshot per requested
    // connector so the Work surface is exercisable offline.
    const built: WorkSource[] = [];
    if (sources.includes("ado")) {
      built.push({
        source: "ado",
        available: true,
        items: [
          {
            id: "ado-501",
            source: "ado",
            kind: "work_item" as const,
            category: "Assigned",
            title: "Ship the observability hub",
            repository: "HoneyHub",
            url: "https://dev.azure.com/honeydrunk/HoneyHub/_workitems/edit/501",
            state: "Active",
            number: 501
          }
        ]
      });
    }
    if (sources.includes("github")) {
      built.push({
        source: "github",
        available: true,
        items: [
              {
                id: "https://github.com/honeydrunk/honeyhub/issues/42",
                source: "github",
                kind: "issue",
                category: "Assigned",
                title: "Wire the work hub",
                repository: "honeydrunk/honeyhub",
                url: "https://github.com/honeydrunk/honeyhub/issues/42",
                state: "open",
                number: 42,
                updatedAt: "2026-06-14T12:00:00Z",
                labels: ["enhancement"]
              },
              {
                id: "https://github.com/honeydrunk/honeyhub/pull/43",
                source: "github",
                kind: "pull_request",
                category: "Authored",
                title: "Add GitHub connector",
                repository: "honeydrunk/honeyhub",
                url: "https://github.com/honeydrunk/honeyhub/pull/43",
                state: "open",
                number: 43,
                updatedAt: "2026-06-14T13:00:00Z"
              },
              {
                id: "https://github.com/honeydrunk/architecture/pull/77",
                source: "github",
                kind: "pull_request",
                category: "Review requested",
                title: "ADR-0091 mobile pairing",
                repository: "honeydrunk/architecture",
                url: "https://github.com/honeydrunk/architecture/pull/77",
                state: "open",
                number: 77
              }
            ]
      });
    }
    this.emitDevice({
      kind: "work_snapshot",
      snapshot: { sources: built }
    });
  }

  async listServiceBus(): Promise<void> {
    // The real host shells `az servicebus`; the mock scripts one namespace with a queue (with
    // a dead-letter backlog) and a topic subscription, so the surface is exercisable offline.
    this.emitDevice({
      kind: "service_bus_snapshot",
      snapshot: {
        available: true,
        namespaces: [
          {
            name: "hd-bus-dev",
            resourceGroup: "rg-honeydrunk",
            location: "eastus",
            entities: [
              {
                name: "notify-queue",
                kind: "queue",
                namespace: "hd-bus-dev",
                status: "Active",
                active: 12,
                deadLetter: 3,
                scheduled: 0
              },
              {
                name: "pulse-sub",
                kind: "subscription",
                namespace: "hd-bus-dev",
                topic: "telemetry",
                status: "Active",
                active: 0,
                deadLetter: 0,
                scheduled: 0
              }
            ]
          }
        ]
      }
    });
  }

  async listAzureSubscriptions(): Promise<void> {
    // The real host shells `az account list`; the mock scripts two subscriptions (one default)
    // so the Key Vault subscription picker is exercisable offline.
    this.emitDevice({
      kind: "azure_subscriptions",
      subscriptions: {
        available: true,
        subscriptions: [
          {
            id: MOCK_SUBSCRIPTION_DEV,
            name: "HoneyDrunk Dev",
            isDefault: true,
            tenantId: MOCK_TENANT,
            state: "Enabled"
          },
          {
            id: MOCK_SUBSCRIPTION_PROD,
            name: "HoneyDrunk Prod",
            isDefault: false,
            tenantId: MOCK_TENANT,
            state: "Enabled"
          },
          {
            // A subscription with no scripted vaults: stands in for one the operator can see but
            // cannot read, so the offline surface can exercise the partial-failure warning.
            id: MOCK_SUBSCRIPTION_LOCKED,
            name: "HoneyDrunk Locked",
            isDefault: false,
            tenantId: MOCK_TENANT,
            state: "Enabled"
          }
        ]
      }
    });
  }

  async listKeyVaults(subscriptionIds: string[]): Promise<void> {
    // The real host shells `az keyvault list` per subscription; the mock scripts a couple of
    // vaults per subscription so the surface is exercisable offline. Only the requested
    // subscriptions contribute, mirroring the host's per-subscription reads.
    const bySubscription: Record<string, KeyVault[]> = {
      [MOCK_SUBSCRIPTION_DEV]: [
        {
          name: "kv-honeydrunk-dev",
          resourceGroup: "rg-honeydrunk",
          location: "eastus",
          subscriptionId: MOCK_SUBSCRIPTION_DEV,
          uri: "https://kv-honeydrunk-dev.vault.azure.net/"
        },
        {
          name: "kv-automation-dev",
          resourceGroup: "rg-automation",
          location: "eastus",
          subscriptionId: MOCK_SUBSCRIPTION_DEV,
          uri: "https://kv-automation-dev.vault.azure.net/"
        }
      ],
      [MOCK_SUBSCRIPTION_PROD]: [
        {
          name: "kv-honeydrunk-prod",
          resourceGroup: "rg-honeydrunk",
          location: "eastus",
          subscriptionId: MOCK_SUBSCRIPTION_PROD,
          uri: "https://kv-honeydrunk-prod.vault.azure.net/"
        }
      ]
    };
    const vaults: KeyVault[] = [];
    const unreadable: string[] = [];
    for (const id of subscriptionIds) {
      const found = bySubscription[id];
      if (found !== undefined) {
        vaults.push(...found);
      } else {
        // A selected subscription with no scripted vaults stands in for one we can't read.
        unreadable.push(id);
      }
    }
    this.emitDevice({
      kind: "key_vaults",
      vaults: { available: true, subscriptionIds, unreadable, vaults }
    });
  }

  async listVaultObjects(vault: string, subscriptionId: string): Promise<void> {
    // The real host shells `az keyvault {secret,key,certificate} list`; the mock scripts a mix of
    // objects (one expired, one far-future, one disabled, plus a key and a certificate) so the
    // surface, expiry badges, and reveal are exercisable offline.
    const byVault: Record<string, VaultObject[]> = {
      "kv-honeydrunk-dev": [
        { name: "db-password", kind: "secret", enabled: true, expires: "2026-01-15T00:00:00+00:00", contentType: "password" },
        { name: "api-key", kind: "secret", enabled: true, expires: "2030-01-01T00:00:00+00:00" },
        { name: "legacy-token", kind: "secret", enabled: false },
        { name: "signing-key", kind: "key", enabled: true, expires: "2030-06-01T00:00:00+00:00" },
        { name: "tls-cert", kind: "certificate", enabled: true, expires: "2026-02-01T00:00:00+00:00" }
      ],
      "kv-automation-dev": [
        { name: "webhook-secret", kind: "secret", enabled: true }
      ],
      "kv-honeydrunk-prod": [
        { name: "prod-db-password", kind: "secret", enabled: true, expires: "2027-12-31T00:00:00+00:00", contentType: "password" }
      ]
    };
    const objects = byVault[vault] ?? [];
    this.emitDevice({
      kind: "vault_objects",
      objects: { available: true, vault, subscriptionId, objects }
    });
  }

  async revealSecret(vault: string, subscriptionId: string, name: string): Promise<void> {
    // The real host shells `az keyvault secret show`; the mock synthesizes an obviously-fake value
    // from the name (no hard-coded credential literals).
    const reveal: SecretReveal = { ok: true, vault, subscriptionId, name, value: `demo-value-for-${name}` };
    if (this.deferReveals) {
      this.deferredReveals.push(reveal);
      return;
    }
    this.emitDevice({ kind: "secret_reveal", reveal });
  }

  /** Test hook: release any reveal responses queued while `deferReveals` was set. */
  flushReveals(): void {
    const queued = this.deferredReveals;
    this.deferredReveals = [];
    for (const reveal of queued) {
      this.emitDevice({ kind: "secret_reveal", reveal });
    }
  }

  async scanKeyVaultExpiry(subscriptionIds: string[]): Promise<void> {
    // The real host walks every vault's objects via `az`; the mock scripts the objects-with-expiry
    // for the requested subscriptions (one already expired, some far-future) so the expiry-alert
    // engine is exercisable offline.
    const bySubscription: Record<string, ExpiringObject[]> = {
      [MOCK_SUBSCRIPTION_DEV]: [
        { vault: "kv-honeydrunk-dev", subscriptionId: MOCK_SUBSCRIPTION_DEV, kind: "secret", name: "db-password", expires: "2026-01-15T00:00:00+00:00" },
        { vault: "kv-honeydrunk-dev", subscriptionId: MOCK_SUBSCRIPTION_DEV, kind: "secret", name: "api-key", expires: "2030-01-01T00:00:00+00:00" },
        { vault: "kv-honeydrunk-dev", subscriptionId: MOCK_SUBSCRIPTION_DEV, kind: "certificate", name: "tls-cert", expires: "2026-02-01T00:00:00+00:00" }
      ],
      [MOCK_SUBSCRIPTION_PROD]: [
        { vault: "kv-honeydrunk-prod", subscriptionId: MOCK_SUBSCRIPTION_PROD, kind: "secret", name: "prod-db-password", expires: "2027-12-31T00:00:00+00:00" }
      ]
    };
    const objects = subscriptionIds.flatMap((id) => bySubscription[id] ?? []);
    this.emitDevice({
      kind: "key_vault_expiry",
      expiring: { available: true, subscriptionIds, objects }
    });
  }

  async grafanaSummary(baseUrl: string, token: string): Promise<void> {
    // The real host curls Grafana; the mock reflects config state — "not configured" with no
    // baseUrl, otherwise a scripted healthy instance with a couple of dashboards.
    if (baseUrl.trim() === "") {
      this.emitDevice({
        kind: "grafana_summary",
        summary: {
          available: false,
          error: "not configured: add your Grafana base URL in Settings",
          baseUrl: "",
          dashboards: []
        }
      });
      return;
    }
    const base = baseUrl.trim().replace(/\/$/, "");
    this.emitDevice({
      kind: "grafana_summary",
      summary: {
        available: true,
        baseUrl: base,
        version: "10.4.2",
        database: "ok",
        dashboards: [
          { title: "Pulse Overview", uid: "pulse1", url: `${base}/d/pulse1/pulse-overview`, folder: "Pulse" },
          { title: "Traces (Tempo)", uid: "tempo1", url: `${base}/d/tempo1/traces` }
        ]
      }
    });
  }

  async sentrySummary(config: {
    baseUrl: string;
    org: string;
    project: string;
    token: string;
  }): Promise<void> {
    // The real host curls the Sentry API; the mock reflects config state — "not configured"
    // without org/project/token, otherwise a couple of scripted unresolved issues.
    if (config.org.trim() === "" || config.project.trim() === "" || config.token.trim() === "") {
      this.emitDevice({
        kind: "sentry_summary",
        summary: {
          available: false,
          error: "not configured: add your Sentry org, project, and token in Settings",
          issues: []
        }
      });
      return;
    }
    this.emitDevice({
      kind: "sentry_summary",
      summary: {
        available: true,
        issues: [
          {
            id: "100",
            shortId: "HONEYHUB-1A",
            title: "TypeError: cannot read properties of undefined",
            culprit: "WorkView.tsx",
            level: "error",
            count: 42,
            userCount: 5,
            permalink: "https://sentry.io/organizations/honeydrunk/issues/100/",
            lastSeen: "2026-06-14T21:00:00Z"
          },
          {
            id: "101",
            shortId: "HONEYHUB-1B",
            title: "Warning: slow render",
            level: "warning",
            count: 8,
            userCount: 2,
            permalink: "https://sentry.io/organizations/honeydrunk/issues/101/"
          }
        ]
      }
    });
  }

  async peekServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
    count?: number;
  }): Promise<void> {
    // The real host shells the explorer helper; the mock scripts a couple of peeked messages
    // (and a dead-letter one when the DLQ is requested) so the surface is exercisable offline.
    this.emitDevice({
      kind: "service_bus_peek",
      peek: {
        available: true,
        namespace: request.namespace,
        entity: request.entity,
        ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
        deadLetter: request.deadLetter ?? false,
        messages: request.deadLetter
          ? [
              {
                messageId: "dlq-1",
                sequenceNumber: 91,
                enqueuedTime: "2026-06-15T09:00:00Z",
                subject: "order.created",
                deliveryCount: 10,
                body: '{"orderId":7}',
                deadLetterReason: "MaxDeliveryCountExceeded"
              }
            ]
          : [
              {
                messageId: "m-1",
                sequenceNumber: 101,
                enqueuedTime: "2026-06-15T10:00:00Z",
                subject: "order.created",
                deliveryCount: 1,
                body: '{"orderId":42}'
              },
              {
                messageId: "m-2",
                sequenceNumber: 102,
                enqueuedTime: "2026-06-15T10:01:00Z",
                deliveryCount: 1,
                body: "plain text message"
              }
            ]
      }
    });
  }

  async resubmitDeadLetter(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    count?: number;
  }): Promise<void> {
    // The real host shells the explorer helper; the mock reports a successful move.
    this.emitDevice({
      kind: "service_bus_resubmit",
      result: {
        ok: true,
        moved: request.count ?? 1,
        namespace: request.namespace,
        entity: request.entity,
        ...(request.subscription === undefined ? {} : { subscription: request.subscription })
      }
    });
  }

  async purgeServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void> {
    // The real host shells the explorer helper; the mock reports a successful drain.
    this.emitDevice({
      kind: "service_bus_purge",
      result: {
        ok: true,
        purged: 5,
        namespace: request.namespace,
        entity: request.entity,
        ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
        deadLetter: request.deadLetter ?? false
      }
    });
  }

  async sendServiceBus(request: {
    namespace: string;
    entity: string;
    body: string;
    subject?: string;
    contentType?: string;
  }): Promise<void> {
    // The real host shells the explorer helper; the mock reports a successful publish.
    this.emitDevice({
      kind: "service_bus_send",
      result: { ok: true, namespace: request.namespace, entity: request.entity }
    });
  }

  async receiveServiceBus(request: {
    namespace: string;
    entity: string;
    subscription?: string;
    deadLetter?: boolean;
  }): Promise<void> {
    // The real host shells the explorer helper; the mock returns one consumed message.
    this.emitDevice({
      kind: "service_bus_receive",
      result: {
        ok: true,
        empty: false,
        namespace: request.namespace,
        entity: request.entity,
        ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
        deadLetter: request.deadLetter ?? false,
        message: {
          messageId: "rcv-1",
          sequenceNumber: 200,
          enqueuedTime: "2026-06-15T10:30:00Z",
          subject: "order.created",
          deliveryCount: 1,
          body: '{"orderId":7}'
        }
      }
    });
  }

  async listServiceBusEntities(request: {
    namespace: string;
    connectionString?: string;
  }): Promise<void> {
    // The real host shells the explorer helper's admin client; the mock scripts a queue (with a
    // DLQ backlog) and a topic + subscription so the connection explorer is exercisable offline.
    this.emitDevice({
      kind: "service_bus_entities",
      entities: {
        available: true,
        namespace: request.namespace,
        queues: [
          {
            name: "notify-queue",
            status: "Active",
            active: 12,
            deadLetter: 3,
            scheduled: 0,
            props: {
              maxSizeMb: 1024,
              maxDeliveryCount: 10,
              lockDurationSeconds: 30,
              defaultTtlSeconds: 1209600,
              deadLetterOnExpiration: false
            }
          }
        ],
        topics: [
          {
            name: "telemetry",
            status: "Active",
            props: { maxSizeMb: 2048, defaultTtlSeconds: 1209600 },
            subscriptions: [
              {
                name: "pulse-sub",
                status: "Active",
                active: 0,
                deadLetter: 0,
                props: { maxDeliveryCount: 10, lockDurationSeconds: 60 }
              }
            ]
          }
        ]
      }
    });
  }

  async manageServiceBus(request: {
    namespace: string;
    connectionString?: string;
    op: "create" | "delete" | "update";
    entityKind: "queue" | "topic" | "subscription";
    entity: string;
    subscription?: string;
    props?: { [key: string]: unknown };
  }): Promise<void> {
    // The real host shells the explorer helper; the mock reports success.
    this.emitDevice({
      kind: "service_bus_manage",
      result: {
        ok: true,
        namespace: request.namespace,
        op: request.op,
        kind: request.entityKind,
        entity: request.entity,
        ...(request.subscription === undefined ? {} : { subscription: request.subscription }),
        message: `(demo) ${request.op}d ${request.entityKind} ${request.entity}`
      }
    });
  }

  async listJobs(options?: {
    extraProbes?: JobProbe[];
    extraTaskKeywords?: string[];
  }): Promise<void> {
    // The real host shells out to the OS process lister; the mock scripts a small snapshot
    // so the Jobs surface is exercisable offline (one known job up, one down). User-defined
    // probes are echoed back as additional (not-running) known jobs, mirroring how the host
    // merges them onto the built-ins, so the "Add job" flow is exercisable offline.
    const userKnown = (options?.extraProbes ?? []).map((probe) => ({
      label: probe.label,
      patterns: probe.patterns,
      running: false,
      instances: 0,
      pids: [] as number[],
      memoryKb: 0
    }));
    this.emitDevice({
      kind: "job_snapshot",
      snapshot: {
        known: [
          {
            label: "Claude Code",
            patterns: ["claude"],
            running: true,
            instances: 1,
            pids: [4242],
            memoryKb: 128_000
          },
          {
            label: "Codex",
            patterns: ["codex"],
            running: false,
            instances: 0,
            pids: [],
            memoryKb: 0
          },
          ...userKnown
        ],
        scheduled: [
          {
            name: "grid-agent-runner",
            path: "\\",
            state: "Ready",
            lastRun: "2026-06-14T10:00:00Z",
            lastResult: 0,
            nextRun: "2026-06-14T16:00:00Z"
          },
          {
            name: "honeydrunk-nightly-sync",
            path: "\\HoneyDrunk\\",
            state: "Ready",
            lastRun: "2026-06-13T03:00:00Z",
            lastResult: 1
          }
        ],
        processes: [
          { pid: 4242, name: "claude.exe", memoryKb: 128_000, command: "claude -p --output-format stream-json" },
          { pid: 1001, name: "node.exe", memoryKb: 64_000, command: "node vite dev" }
        ],
        truncated: false
      }
    });
  }

  /** Emit a device-scoped event (empty session/run ids, sequence 0). */
  private emitDevice(payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: `event-${this.sequence}`,
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: this.createdAt,
      payload
    };
    this.sequence += 1;
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
