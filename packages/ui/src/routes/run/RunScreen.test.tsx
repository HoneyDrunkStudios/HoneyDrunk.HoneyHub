import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentBackend, StartRunRequest } from "@honeydrunk/honeyhub-types";
import { RunScreen } from "./RunScreen";
import { MockWireClient } from "../../wire/mockClient";

// All three backends configured — the realistic state in which routing chooses
// among options (an unconfigured cockpit offers only the proven-initial backend).
const ALL_BACKENDS: AgentBackend[] = ["claude.local", "codex.local", "copilot.local"];

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
  fireEvent.change(screen.getByLabelText("Workspace root"), {
    target: { value: "/work/honeyhub" }
  });
  fireEvent.change(screen.getByLabelText("Task"), { target: { value: task } });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
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

    // A follow-up after completion starts a NEW run (it goes active again).
    fireEvent.change(screen.getByLabelText("Follow up"), { target: { value: "add tests too" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Run state").textContent).toBe("needs_input")
    );
  });

  it("suggests a backend from the task and lets the user override it", () => {
    render(<RunScreen client={new MockWireClient()} availableBackends={ALL_BACKENDS} />);
    const backendSelect = screen.getByLabelText("Backend") as HTMLSelectElement;

    // A complex task routes to the most capable backend (Claude).
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model and debug the race condition" }
    });
    expect(backendSelect.value).toBe("claude.local");
    expect(screen.getByText(/Complex task/)).toBeTruthy();

    // A light task routes to the lowest-cost backend (Copilot).
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Fix a typo in the readme" }
    });
    expect(backendSelect.value).toBe("copilot.local");

    // Manual override pins the choice — a new task no longer moves it.
    fireEvent.change(backendSelect, { target: { value: "codex.local" } });
    expect(backendSelect.value).toBe("codex.local");
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Redesign the whole architecture" }
    });
    expect(backendSelect.value).toBe("codex.local");
  });

  it("launches the run on the suggested backend by default", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} />);
    fireEvent.change(screen.getByLabelText("Workspace root"), { target: { value: "/work" } });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model and debug the race" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("claude.local");
  });

  it("launches the run on an overridden backend", async () => {
    const { client, started } = recordingClient();
    render(<RunScreen client={client} availableBackends={ALL_BACKENDS} />);
    fireEvent.change(screen.getByLabelText("Workspace root"), { target: { value: "/work" } });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor the concurrency model" }
    });
    // Override the suggestion before launching.
    fireEvent.change(screen.getByLabelText("Backend"), { target: { value: "codex.local" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.session.backend).toBe("codex.local");
  });

  it("offers only the configured backends and routes among them", () => {
    render(
      <RunScreen
        client={new MockWireClient()}
        availableBackends={["codex.local", "copilot.local"]}
      />
    );
    const select = screen.getByLabelText("Backend") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "codex.local",
      "copilot.local"
    ]);
    // A complex task routes AMONG the available set, never the unavailable Claude
    // (which is the most capable but not offered). Among the equal-capability pair,
    // the cost tiebreak picks Copilot.
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Refactor and redesign the whole architecture" }
    });
    expect(select.value).not.toBe("claude.local");
    expect(select.value).toBe("copilot.local");
  });

  it("offers only the proven-initial backend when none are configured", () => {
    // An unconfigured cockpit must not imply Codex/Copilot are launchable (the user
    // may not have those CLIs) — only the proven-initial backend (Claude) is offered
    // until the user adds others in Bridge settings.
    render(<RunScreen client={new MockWireClient()} />);
    const select = screen.getByLabelText("Backend") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["claude.local"]);
  });

  it("drops a pinned backend once it is no longer offered", () => {
    const client = new MockWireClient();
    const { rerender } = render(
      <RunScreen client={client} availableBackends={["claude.local", "codex.local"]} />
    );
    const select = screen.getByLabelText("Backend") as HTMLSelectElement;
    // Pin Claude explicitly.
    fireEvent.change(select, { target: { value: "claude.local" } });
    expect(select.value).toBe("claude.local");

    // Reconfigure the allowlist to exclude Claude — the stale pin is dropped and the
    // select falls back to an offered backend (never the unavailable Claude).
    rerender(<RunScreen client={client} availableBackends={["codex.local", "copilot.local"]} />);
    expect(select.value).not.toBe("claude.local");
    expect(["codex.local", "copilot.local"]).toContain(select.value);
  });

  it("does not resurrect a pin after its backend is removed and later re-added", () => {
    const client = new MockWireClient();
    const { rerender } = render(<RunScreen client={client} availableBackends={ALL_BACKENDS} />);
    const select = screen.getByLabelText("Backend") as HTMLSelectElement;

    // With no override, the select shows the router's live suggestion.
    const suggested = select.value;
    // Pin a backend that differs from the suggestion.
    const pick = ALL_BACKENDS.find((b) => b !== suggested) ?? "copilot.local";
    fireEvent.change(select, { target: { value: pick } });
    expect(select.value).toBe(pick);

    // Remove the pinned backend from the configured set: the pin is dropped.
    rerender(
      <RunScreen client={client} availableBackends={ALL_BACKENDS.filter((b) => b !== pick)} />
    );
    expect(select.value).not.toBe(pick);

    // Re-add it. The cleared pin must NOT silently resume — the select stays on the
    // live suggestion rather than resurrecting the old override.
    rerender(<RunScreen client={client} availableBackends={ALL_BACKENDS} />);
    expect(select.value).toBe(suggested);
  });

  it("freezes the active run's backend in diagnostics across a mid-run config change", async () => {
    const client = new MockWireClient();
    const { rerender } = render(
      <RunScreen client={client} availableBackends={["claude.local"]} />
    );
    fireEvent.change(screen.getByLabelText("Workspace root"), { target: { value: "/work" } });
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
