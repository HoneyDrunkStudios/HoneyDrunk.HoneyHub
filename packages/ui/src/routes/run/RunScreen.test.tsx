import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentBackend,
  BackendCapability,
  StartRunRequest
} from "@honeydrunk/honeyhub-types";
import {
  defaultClaudeCapabilities,
  defaultCodexCapabilities
} from "@honeydrunk/honeyhub-types";
import { RunScreen } from "./RunScreen";
import { MockWireClient } from "../../wire/mockClient";
import { getChat, loadChats, renameChat, saveChat, type ChatRecord } from "../../chatHistory";

// The surfaced backends configured — the realistic state in which routing chooses
// among options (an unconfigured cockpit offers only the proven-initial backend).
const ALL_BACKENDS: AgentBackend[] = ["claude.local", "codex.local"];

// A detection catalog so the model picker has models per provider.
const CATALOG: BackendCapability[] = [
  {
    backend: "claude.local",
    program: "claude",
    available: true,
    capabilities: defaultClaudeCapabilities,
    models: [
      { id: "opus", label: "Claude Opus 4.8" },
      { id: "sonnet", label: "Claude Sonnet 4.6" },
      { id: "haiku", label: "Claude Haiku 4.5" }
    ],
    modelSource: "bridge_known"
  },
  {
    backend: "codex.local",
    program: "codex",
    available: true,
    capabilities: defaultCodexCapabilities,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" }
    ],
    modelSource: "cli_cache"
  }
];

/** A minimal in-memory Storage for tests (jsdom here exposes no localStorage), enough
    for the chat-history store's getItem/setItem round-trip. */
class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

/** A mock client that records every StartRunRequest it is asked to launch. */
function recordingClient(): { client: MockWireClient; started: StartRunRequest[] } {
  const client = new MockWireClient();
  const started: StartRunRequest[] = [];
  const realStart = client.start.bind(client);
  client.start = (request) => {
    started.push(request);
    return realStart(request);
  };
  return { client, started };
}

function startRun(task = "Add a feature") {
  render(<RunScreen client={new MockWireClient()} />);
  fireEvent.change(screen.getByLabelText("Task"), { target: { value: task } });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
}

/** Open the composer's config drop-up (idempotent: opens it if closed). */
function openConfigPanel() {
  const trigger = screen.getByRole("button", { name: "Configure run" });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

/** Switch the run screen into manual ("Pick model") mode (inside the config panel). */
function pickModelMode() {
  openConfigPanel();
  fireEvent.click(screen.getByRole("button", { name: "Pick model" }));
}

/** Open the unified model dropdown and click the option whose label matches. */
function pickModelOption(label: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const listbox = screen.getByRole("listbox", { name: "Select model" });
  fireEvent.click(within(listbox).getByRole("option", { name: label }));
}

/** The label currently shown on the model dropdown trigger. */
function modelButtonText(): string {
  return screen.getByRole("button", { name: "Model" }).textContent ?? "";
}

/** The model option labels currently offered (excludes the trailing "Custom model…"). */
function listModelOptions(): string[] {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const listbox = screen.getByRole("listbox", { name: "Select model" });
  return within(listbox)
    .getAllByRole("option")
    .map((option) => option.querySelector(".model-option-label")?.textContent ?? "")
    .filter((label) => label !== "Custom model…");
}

describe("RunScreen", () => {
  it("drives start -> stream -> needs_input -> reply -> completed", async () => {
    startRun();

    // Streamed agent turn surfaces the question and the run enters needs_input.
    await waitFor(() =>
      expect(
        screen.getByText("I can take that on. Which file should I change?")
      ).toBeTruthy()
    );
    expect(screen.getByLabelText("Run state").textContent).toBe("needs_input");

    // Reply (same-process) -> the run completes with a PR artifact and exact usage.
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "the readme" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(screen.getByText("Done. Opened a pull request.")).toBeTruthy()
    );
    expect(screen.getByLabelText("Run state").textContent).toBe("completed");

    const artifacts = screen.getByRole("list", { name: "Artifacts" });
    expect(within(artifacts).getByRole("link", { name: "Open PR" }).getAttribute("href")).toBe(
      "https://example.test/pr/1"
    );

    // Usage renders with exact fidelity.
    expect(screen.getByLabelText("Usage (exact)")).toBeTruthy();
    expect(screen.getByText("$0.0182")).toBeTruthy();

    // The right-panel activity stream shows what the agent did (tool/file activity).
    const activity = screen.getByRole("list", { name: "Activity" });
    expect(within(activity).getByText("Read")).toBeTruthy();
    expect(within(activity).getByText("src/app.ts")).toBeTruthy();

    // A follow-up after completion starts a NEW run (it goes active again).
    fireEvent.change(screen.getByLabelText("Follow up"), { target: { value: "add tests too" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
    );
  });

  it("optimize mode suggests a backend from the task (no manual pickers shown)", () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} />);

    // Optimize is the default: there is no provider/model select, just the rationale.
    expect(screen.queryByLabelText("Provider")).toBeNull();

    // A complex task routes to the most capable backend (Claude). The rationale lives
    // in the config drop-up now, so open it to read the routing explanation.
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model and debug the race condition" }
    });
    openConfigPanel();
    expect(screen.getByText(/Complex task/)).toBeTruthy();
    // "Claude Code" also appears in synced history; assert the routing rationale names it.
    expect(screen.getAllByText(/Claude Code/).length).toBeGreaterThan(0);

    // A light task routes to the lowest-cost backend (Copilot).
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix a typo in the readme" }
    });
    expect(screen.getByText(/Light task/)).toBeTruthy();
  });

  it("checks plan usage from the config panel and renders the meters", async () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} />);
    openConfigPanel();

    // Fire both probes; the mock answers with scripted vendor meters.
    fireEvent.click(screen.getByRole("button", { name: "Check Claude Code" }));
    expect(await screen.findByText(/Current session \(5h\): 34% used/)).toBeTruthy();
    expect(screen.getByText(/Claude Code · as of/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check Codex" }));
    await waitFor(() => expect(screen.getByText(/Codex · as of/)).toBeTruthy());
  });

  it("degrades a usage probe to the raw capture (or the failure) when parsing found nothing", async () => {
    // Script the host-shaped edge cases the default mock never emits: an
    // unrecognized panel layout (ok, no windows) and a failed spawn.
    class EdgeProbeClient extends MockWireClient {
      override async probeUsage(backend: AgentBackend): Promise<void> {
        this.emitDevice({
          kind: "usage_probe",
          report:
            backend === "claude.local"
              ? {
                  backend,
                  ok: true,
                  windows: [],
                  raw: "some unrecognized panel text",
                  capturedAt: "2026-07-04T12:00:00Z"
                }
              : {
                  backend,
                  ok: false,
                  windows: [],
                  raw: "could not launch codex: not found",
                  capturedAt: "2026-07-04T12:00:00Z"
                }
        });
      }
    }
    render(<RunScreen client={new EdgeProbeClient()} availableBackends={ALL_BACKENDS} />);
    openConfigPanel();

    fireEvent.click(screen.getByRole("button", { name: "Check Claude Code" }));
    expect(await screen.findByText("raw capture (layout not recognized)")).toBeTruthy();
    expect(screen.getByText("some unrecognized panel text")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check Codex" }));
    expect(await screen.findByText("probe failed")).toBeTruthy();
    expect(screen.getByText(/could not launch codex/)).toBeTruthy();
  });

  it("lists synced history and reopens a past session read-only", async () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} />);

    // The mock reports one durable past session in the bridge-backed threads list.
    const history = await screen.findByRole("list", { name: "Synced chats" });
    const entry = within(history).getByText("Wire the deploy triggers");
    fireEvent.click(entry);

    // Clicking fetches its detail and reopens the transcript read-only, with the
    // per-thread cost rollup the host attached to the detail.
    await waitFor(() =>
      expect(screen.getByText("Done. Staged the workflow and opened a PR.")).toBeTruthy()
    );
    expect(screen.getByText(/Thread cost: \$0\.0421 · 2 turns/)).toBeTruthy();
  });

  it("manual mode lets the user pin a model that the task no longer moves", () => {
    render(
      <RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} catalog={CATALOG} />
    );
    pickModelMode();
    pickModelOption(/GPT-5\.5/);
    expect(modelButtonText()).toContain("GPT-5.5");

    // A new task no longer moves the pinned (Codex) model.
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Redesign the whole architecture" }
    });
    expect(modelButtonText()).toContain("GPT-5.5");
  });

  it("launches the run on the suggested backend by default (optimize, no model pin)", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} />);
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model and debug the race" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("claude.local");
    // Optimize with all models on → no explicit model pin (CLI default).
    expect(started[0]?.model).toBeUndefined();
  });

  it("launches on an overridden provider + model in manual mode", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model" }
    });
    pickModelMode();
    pickModelOption(/Claude Haiku 4\.5/);
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("claude.local");
    expect(started[0]?.model).toBe("haiku");
  });

  it("the unified model picker offers only the configured backends' models", () => {
    render(
      <RunScreen
        client={new MockWireClient()}
        availableBackends={["claude.local", "codex.local"]}
        catalog={CATALOG}
      />
    );
    pickModelMode();
    expect(listModelOptions()).toEqual([
      "Claude Opus 4.8",
      "Claude Sonnet 4.6",
      "Claude Haiku 4.5",
      "GPT-5.5",
      "GPT-5.4-Mini"
    ]);
  });

  it("supports a custom (free-text) model id in manual mode", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Fix a typo" } });
    pickModelMode();
    // Pick a Codex model (routes to codex), then switch to the custom entry.
    pickModelOption(/GPT-5\.5/);
    pickModelOption(/Custom model/);
    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "gpt-5.5-codex" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("codex.local");
    expect(started[0]?.model).toBe("gpt-5.5-codex");
  });

  it("aims a custom model at a chosen backend via the custom-mode toggle", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Fix a typo" } });
    pickModelMode();
    pickModelOption(/GPT-5\.5/);
    pickModelOption(/Custom model/);
    // The custom-mode backend toggle re-aims the custom id at Claude.
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "claude-opus-4-8" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("claude.local");
    expect(started[0]?.model).toBe("claude-opus-4-8");
  });

  it("offers a Codex reasoning-effort selector and launches with the chosen effort", async () => {
    const { client, started } = recordingClient();
    // A catalog where the Codex model exposes reasoning levels (Claude has none).
    const catalog: BackendCapability[] = [
      CATALOG[0]!,
      {
        ...CATALOG[1]!,
        models: [
          { id: "gpt-5.5", label: "GPT-5.5", reasoningLevels: ["low", "medium", "high"] }
        ]
      }
    ];
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={catalog} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Refactor" } });
    pickModelMode();
    pickModelOption(/GPT-5\.5/);
    // The effort selector appears (Codex + a model with levels) and Claude would not show it.
    const effort = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("codex.local");
    expect(started[0]?.effort).toBe("high");
  });

  it("opens the slash menu and /model switches to manual mode", () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "/mod" } });
    // The slash popover appears, filtered to the model command.
    expect(screen.getByLabelText("Slash commands")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /\/model/ }));
    // /model put the composer into manual mode, so the model picker is now shown.
    expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
  });

  it("offers only the proven-initial backend when none are configured", () => {
    // An unconfigured cockpit must not imply Codex/Copilot are launchable (the user
    // may not have those CLIs) — only the proven-initial backend (Claude) is offered
    // until the user adds others in Bridge settings.
    render(<RunScreen client={new MockWireClient()} catalog={CATALOG} />);
    pickModelMode();
    // Only the proven-initial backend's models are offered.
    expect(listModelOptions()).toEqual([
      "Claude Opus 4.8",
      "Claude Sonnet 4.6",
      "Claude Haiku 4.5"
    ]);
  });

  it("restricts the model picker (and the auto choice) to enabled models", async () => {
    const { client, started } = recordingClient();
    // Only 'sonnet' is enabled for Claude.
    render(
      <RunScreen
        client={client}
        availableBackends={["claude.local"]}
        catalog={CATALOG}
        enabledModels={{ "claude.local": ["sonnet"] }}
      />
    );
    pickModelMode();
    // The picker (and the auto choice) are restricted to the enabled model.
    expect(listModelOptions()).toEqual(["Claude Sonnet 4.6"]);

    // Even back in optimize mode, the auto choice pins the only enabled model.
    fireEvent.click(screen.getByRole("button", { name: "Optimize cost" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Fix a typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.model).toBe("sonnet");
  });

  it("drops a pinned provider once it is no longer offered", () => {
    const client = new MockWireClient();
    const { rerender } = render(
      <RunScreen
        client={client}
        availableBackends={["claude.local", "codex.local"]}
        catalog={CATALOG}
      />
    );
    pickModelMode();
    pickModelOption(/Claude Sonnet/);
    expect(modelButtonText()).toContain("Claude Sonnet");

    // Reconfigure the allowlist to exclude Claude. The stale pin is dropped and the
    // picker falls back to an offered backend (never the unavailable Claude).
    rerender(
      <RunScreen
        client={client}
        availableBackends={["codex.local", "copilot.local"]}
        catalog={CATALOG}
      />
    );
    expect(modelButtonText()).not.toContain("Claude");
  });

  it("freezes the active run's backend in diagnostics across a mid-run config change", async () => {
    const client = new MockWireClient();
    const { rerender } = render(
      <RunScreen client={client} availableBackends={["claude.local"]} />
    );
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Fix a typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
    );
    // The run launched on Claude; its diagnostics show it.
    const diagnostics = screen.getByLabelText("Session diagnostics");
    expect(within(diagnostics).getByText(/claude\.local/)).toBeTruthy();

    // Reconfiguring the backends mid-run must NOT drift the active run's diagnostics
    // to a new suggestion — the launched backend is frozen.
    rerender(<RunScreen client={client} availableBackends={["codex.local", "copilot.local"]} />);
    expect(within(diagnostics).getByText(/claude\.local/)).toBeTruthy();
  });

  it("starts a new chat from an active run and keeps the old thread in the list", async () => {
    // The save effect persists the live chat through localStorage; jsdom here does not
    // expose one, so back it with an in-memory store for this test (RecentChats reads it
    // to list the just-started thread).
    vi.stubGlobal("localStorage", new MemoryStorage());
    try {
      render(<RunScreen client={new MockWireClient()} />);
      // Launch a run so we are in the live transcript view (not the composer).
      const task = "Wire the new-chat button";
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: task } });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));

      // We are in the live run: the transcript shows the user's turn and a run-state pill.
      await waitFor(() =>
        expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
      );
      const transcript = screen.getByLabelText("Transcript");
      expect(within(transcript).getByText(task)).toBeTruthy();

      // The always-available header control starts a fresh thread from the active run.
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));

      // Back at the empty composer: the "Do anything" placeholder shows and the live
      // transcript is gone.
      expect(screen.getByPlaceholderText("Do anything")).toBeTruthy();
      expect(screen.queryByLabelText("Transcript")).toBeNull();

      // The just-started thread was persisted, so it is retrievable from the Chats list.
      const chats = screen.getByRole("list", { name: "Chats" });
      expect(within(chats).getByText(task)).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops an active run", async () => {
    startRun();
    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("cancelled")
    );
    // Stop control is gone once the run is terminal.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("resolves the raw model id to its full catalog label on the chip and launching line", () => {
    render(
      <RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} catalog={CATALOG} />
    );
    pickModelMode();
    pickModelOption(/Claude Opus 4\.8/);

    // The chip shows the full label, not the raw "opus" id.
    const chip = screen.getByRole("button", { name: "Configure run" });
    expect(chip.textContent).toContain("Claude Code · Claude Opus 4.8");
    expect(chip.textContent).not.toContain("· opus");

    // The drop-up's launching line resolves it too.
    expect(document.querySelector(".panel-rationale")?.textContent).toContain(
      "Launching Claude Code · Claude Opus 4.8"
    );
  });

  it("persists a renameable draft thread on New chat and the first run reuses its id", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    try {
      const { client, started } = recordingClient();
      render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);

      // Reach the live view, then start a fresh thread from its header. That mints and
      // persists an empty "New chat" placeholder immediately — before any typing.
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "First thread" } });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
      );
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));

      // The placeholder is persisted and listed before anything is typed.
      const drafts = loadChats().filter((chat) => chat.task === "New chat");
      expect(drafts).toHaveLength(1);
      const draftId = drafts[0]!.id;
      expect(within(screen.getByRole("list", { name: "Chats" })).getByText("New chat")).toBeTruthy();

      // The operator renames the fresh thread up front (before the first message).
      renameChat(draftId, "Planning session");
      expect(getChat(draftId)?.title).toBe("Planning session");

      // Dispatching a run ADOPTS the draft id (requestedRunId), so the same record updates
      // in place: no duplicate thread, and the pre-typing rename survives.
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Do the planning" } });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(started).toHaveLength(2));
      expect(started[1]?.requestedRunId).toBe(draftId);

      await waitFor(() => expect(getChat(draftId)?.task).toBe("Do the planning"));
      expect(getChat(draftId)?.title).toBe("Planning session");
      // Two threads total (first run + adopted draft) — no orphaned "New chat" row.
      expect(loadChats()).toHaveLength(2);
      expect(loadChats().filter((chat) => chat.task === "New chat")).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lights active threads and done-with-answers threads distinctly", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    try {
      const message = (id: string): ChatRecord["messages"][number] => ({
        id: `m-${id}`,
        sessionId: "s",
        runId: id,
        role: "agent",
        body: "here you go",
        createdAt: "2026-07-05T00:00:00Z"
      });
      const base = {
        totalUsd: 0,
        totalTokens: 0,
        createdAt: "2026-07-05T00:00:00Z"
      };
      // A finished thread with answers, an in-flight thread, and an empty draft.
      saveChat({
        ...base,
        id: "done1",
        task: "Finished",
        state: "completed",
        messages: [message("done1")],
        updatedAt: "2026-07-05T03:00:00Z"
      });
      saveChat({
        ...base,
        id: "live1",
        task: "Running",
        state: "running",
        messages: [message("live1")],
        updatedAt: "2026-07-05T02:00:00Z"
      });
      saveChat({
        ...base,
        id: "draft1",
        task: "New chat",
        state: "created",
        messages: [],
        updatedAt: "2026-07-05T01:00:00Z"
      });

      render(
        <RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} catalog={CATALOG} />
      );
      const chats = screen.getByRole("list", { name: "Chats" });

      expect(within(chats).getByLabelText("Chat done with answers")).toBeTruthy();
      expect(within(chats).getByLabelText("Run active")).toBeTruthy();
      // The empty draft has neither: only the two lights above exist.
      expect(
        within(chats).getAllByLabelText(/Run active|Chat done with answers/)
      ).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the session-history dropdown (sidebar) with status lights, no inline list", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    try {
      const message = (id: string): ChatRecord["messages"][number] => ({
        id: `m-${id}`,
        sessionId: "s",
        runId: id,
        role: "agent",
        body: "here you go",
        createdAt: "2026-07-05T00:00:00Z"
      });
      const base = { totalUsd: 0, totalTokens: 0, createdAt: "2026-07-05T00:00:00Z" };
      saveChat({
        ...base,
        id: "done1",
        task: "Finished",
        state: "completed",
        messages: [message("done1")],
        updatedAt: "2026-07-05T03:00:00Z"
      });
      saveChat({
        ...base,
        id: "live1",
        task: "Running",
        state: "running",
        messages: [message("live1")],
        updatedAt: "2026-07-05T02:00:00Z"
      });

      const onClose = vi.fn();
      render(
        <RunScreen
          client={new MockWireClient()}
          variant="sidebar"
          threadsMenuOpen
          onCloseThreadsMenu={onClose}
          availableBackends={ALL_BACKENDS}
          catalog={CATALOG}
        />
      );

      // The dock drops the inline "Threads" section — history lives in the dropdown now.
      expect(screen.queryByText("Threads")).toBeNull();
      const dialog = screen.getByRole("dialog", { name: "Sessions" });

      // The Wave-1 status lights ride onto the Local rows.
      expect(within(dialog).getByLabelText("Chat done with answers")).toBeTruthy();
      expect(within(dialog).getByLabelText("Run active")).toBeTruthy();

      // Opening a row asks the dock to dismiss the panel.
      fireEvent.click(within(dialog).getByText("Finished"));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the selected model and backend across a new chat", async () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    try {
      const { client, started } = recordingClient();
      render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);

      // Pin a distinct backend + model (Codex GPT-5.5).
      pickModelMode();
      pickModelOption(/GPT-5\.5/);
      expect(modelButtonText()).toContain("GPT-5.5");

      // Run, then start a fresh chat from the live view.
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "First" } });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(started).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));

      // The pinned model/backend survive the new chat: still manual, still GPT-5.5.
      openConfigPanel();
      expect(modelButtonText()).toContain("GPT-5.5");

      // And the next run still launches on that pinned backend + model.
      fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Second" } });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(started).toHaveLength(2));
      expect(started[1]?.session.backend).toBe("codex.local");
      expect(started[1]?.model).toBe("gpt-5.5");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
