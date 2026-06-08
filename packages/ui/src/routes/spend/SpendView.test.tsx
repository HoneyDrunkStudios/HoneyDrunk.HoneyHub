import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StartRunRequest } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { SpendView } from "./SpendView";

function startRequest(sessionId: string): StartRunRequest {
  return {
    session: {
      id: sessionId,
      backend: "claude.local",
      title: "Spend test",
      workspaceRoot: "/work",
      createdAt: "2026-06-07T12:00:00Z",
      updatedAt: "2026-06-07T12:00:00Z"
    },
    workspaceRoot: "/work",
    task: "do it",
    requestedRunId: `run-${sessionId}`
  };
}

describe("SpendView", () => {
  it("renders measured spend rolled up from the session's usage", async () => {
    const client = new MockWireClient();
    // Drive a full exchange so the mock accumulates an exact usage signal.
    await client.start(startRequest("s1"));
    await client.reply("run-s1", "go");

    render(<SpendView client={client} active />);

    // The mock's exact usage is $0.0182 → grounded headline rounds to $0.02.
    expect(await screen.findByText("$0.02")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("measured")).toBeTruthy();
    // Local-only posture is stated up front.
    expect(screen.getByText(/never leaves it/i)).toBeTruthy();
  });

  it("shows an empty state when no usage has been recorded", async () => {
    const client = new MockWireClient();
    render(<SpendView client={client} active />);

    await waitFor(() =>
      expect(screen.getByText(/No usage recorded yet/i)).toBeTruthy()
    );
  });

  it("shows a generic error and not the loading copy when the request fails", async () => {
    const client = new MockWireClient();
    client.requestUsageSummary = () => Promise.reject(new Error("ws://127.0.0.1/secret path leaked"));

    render(<SpendView client={client} active />);

    const alert = await screen.findByRole("alert");
    // Generic, no raw host detail leaked.
    expect(alert.textContent).toBe("could not load spend");
    expect(alert.textContent).not.toContain("secret");
    // Not stuck on the loading placeholder after a failure.
    expect(screen.queryByText("Loading your spend…")).toBeNull();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.requestUsageSummary.bind(client);
    client.requestUsageSummary = () => {
      calls += 1;
      return original();
    };

    render(<SpendView client={client} active={false} />);
    expect(calls).toBe(0);
  });
});
