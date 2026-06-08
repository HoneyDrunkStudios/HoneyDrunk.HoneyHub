import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunScreen } from "./RunScreen";
import { MockWireClient } from "../../wire/mockClient";

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
    render(<RunScreen client={new MockWireClient()} />);
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
