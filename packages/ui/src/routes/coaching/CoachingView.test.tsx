import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StartRunRequest } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { CoachingView } from "./CoachingView";

function startRequest(sessionId: string): StartRunRequest {
  return {
    session: {
      id: sessionId,
      backend: "claude.local",
      title: "Coaching test",
      workspaceRoot: "/work",
      createdAt: "2026-06-07T12:00:00Z",
      updatedAt: "2026-06-07T12:00:00Z"
    },
    workspaceRoot: "/work",
    task: "do it",
    requestedRunId: `run-${sessionId}`
  };
}

describe("CoachingView", () => {
  it("renders advisories warning-first for a known session", async () => {
    const client = new MockWireClient();
    await client.start(startRequest("s1"));

    render(<CoachingView client={client} active />);

    // The mock's scripted advisories include a warning and an info hint.
    expect(await screen.findByText("Long session")).toBeTruthy();
    expect(screen.getByText("Estimated usage")).toBeTruthy();
    const badges = screen.getAllByText(/Warning|Info/);
    // Warning is ordered before Info.
    expect(badges[0]?.textContent).toBe("Warning");
    expect(screen.getByText(/Advisory only/i)).toBeTruthy();
  });

  it("shows an empty state when there are no advisories", async () => {
    // No session started → the mock returns no hints.
    const client = new MockWireClient();
    render(<CoachingView client={client} active />);

    await waitFor(() =>
      expect(screen.getByText(/No advisories right now/i)).toBeTruthy()
    );
  });

  it("shows a generic error and not the loading copy when the request fails", async () => {
    const client = new MockWireClient();
    client.requestCoachingHints = () => Promise.reject(new Error("ws://127.0.0.1/secret leaked"));

    render(<CoachingView client={client} active />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("could not load coaching");
    expect(alert.textContent).not.toContain("secret");
    expect(screen.queryByText("Loading coaching…")).toBeNull();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.requestCoachingHints.bind(client);
    client.requestCoachingHints = () => {
      calls += 1;
      return original();
    };

    render(<CoachingView client={client} active={false} />);
    expect(calls).toBe(0);
  });
});
