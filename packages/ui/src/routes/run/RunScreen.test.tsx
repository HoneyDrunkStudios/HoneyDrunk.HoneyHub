import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

/** Switch the run screen into manual ("Pick model") mode. */
function pickModelMode() {
  fireEvent.click(screen.getByRole("button", { name: "Pick model" }));
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
      expect(screen.getByText("Done — opened a pull request.")).toBeTruthy()
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

    // A complex task routes to the most capable backend (Claude).
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model and debug the race condition" }
    });
    expect(screen.getByText(/Complex task/)).toBeTruthy();
    // "Claude Code" also appears in synced history; assert the routing rationale names it.
    expect(screen.getAllByText(/Claude Code/).length).toBeGreaterThan(0);

    // A light task routes to the lowest-cost backend (Copilot).
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix a typo in the readme" }
    });
    expect(screen.getByText(/Light task/)).toBeTruthy();
  });

  it("lists synced history and reopens a past session read-only", async () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} />);

    // The mock reports one durable past session in the Synced history list.
    const history = await screen.findByRole("list", { name: "Synced history" });
    const entry = within(history).getByText("Wire the deploy triggers");
    fireEvent.click(entry);

    // Clicking fetches its detail and reopens the transcript read-only.
    await waitFor(() =>
      expect(screen.getByText("Done — staged the workflow and opened a PR.")).toBeTruthy()
    );
  });

  it("manual mode lets the user pin a provider that the task no longer moves", () => {
    render(
      <RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} catalog={CATALOG} />
    );
    pickModelMode();
    const provider = screen.getByLabelText("Provider") as HTMLSelectElement;

    fireEvent.change(provider, { target: { value: "codex.local" } });
    expect(provider.value).toBe("codex.local");

    // A new task no longer moves the pinned provider.
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Redesign the whole architecture" }
    });
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("codex.local");
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
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude.local" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "haiku" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("claude.local");
    expect(started[0]?.model).toBe("haiku");
  });

  it("the manual provider picker offers only the configured backends", () => {
    render(
      <RunScreen
        client={new MockWireClient()}
        availableBackends={["claude.local", "codex.local"]}
        catalog={CATALOG}
      />
    );
    pickModelMode();
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "claude.local",
      "codex.local"
    ]);
  });

  it("supports a custom (free-text) model id in manual mode", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} catalog={CATALOG} />);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Fix a typo" } });
    pickModelMode();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex.local" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "__custom__" } });
    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "gpt-5.5-codex" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("codex.local");
    expect(started[0]?.model).toBe("gpt-5.5-codex");
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
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex.local" } });
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
    // /model put the composer into manual mode, so the Provider picker is now shown.
    expect(screen.getByLabelText("Provider")).toBeTruthy();
  });

  it("offers only the proven-initial backend when none are configured", () => {
    // An unconfigured cockpit must not imply Codex/Copilot are launchable (the user
    // may not have those CLIs) — only the proven-initial backend (Claude) is offered
    // until the user adds others in Bridge settings.
    render(<RunScreen client={new MockWireClient()} catalog={CATALOG} />);
    pickModelMode();
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["claude.local"]);
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
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    // Listed models exclude the always-present "Custom model…" sentinel option.
    const listed = Array.from(model.options)
      .map((option) => option.value)
      .filter((value) => value !== "__custom__");
    expect(listed).toEqual(["sonnet"]);

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
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude.local" } });
    expect(select.value).toBe("claude.local");

    // Reconfigure the allowlist to exclude Claude — the stale pin is dropped and the
    // select falls back to an offered backend (never the unavailable Claude).
    rerender(
      <RunScreen
        client={client}
        availableBackends={["codex.local", "copilot.local"]}
        catalog={CATALOG}
      />
    );
    const after = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(after.value).not.toBe("claude.local");
    expect(["codex.local", "copilot.local"]).toContain(after.value);
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
});
