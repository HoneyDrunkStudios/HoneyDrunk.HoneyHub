import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BridgeEvent, BridgeEventPayload, GitStatus } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import type { RunSummary } from "../runs/runsModel";
import { GroupsView } from "./GroupsView";

const ROOTS = ["C:/repos/Studios"];

function status(root: string, branch: string, dirty: boolean): GitStatus {
  return {
    root,
    branch,
    ahead: 0,
    behind: 0,
    files: dirty ? [{ path: "src/x.ts", status: " M", staged: false, untracked: false }] : [],
    clean: !dirty
  };
}

function run(runId: string, workspaceRoot: string, task: string): RunSummary {
  return {
    runId,
    sessionId: "s1",
    task,
    state: "running",
    totalUsd: 0,
    totalTokens: 0,
    needsInput: false,
    artifacts: 0,
    workspaceRoot,
    updatedAt: "2026-06-27T00:00:00Z"
  };
}

/** A MockWireClient that lets a test push device-scoped git events (a custom overview /
    diff) through the same subscription the view listens on. */
class PushableWireClient extends MockWireClient {
  private readonly captured = new Set<(event: BridgeEvent) => void>();

  override subscribe(handler: (event: BridgeEvent) => void): () => void {
    this.captured.add(handler);
    const off = super.subscribe(handler);
    return () => {
      this.captured.delete(handler);
      off();
    };
  }

  // Suppress the mock's scripted two-repo overview so each test drives the exact repos it
  // pushes — the view requests an overview per root on mount, which we don't want answered.
  override async gitOverview(): Promise<void> {
    // intentionally no-op; tests push `git_overview` events explicitly.
  }

  push(payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: "test-event",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-27T00:00:00.000Z",
      payload
    };
    act(() => {
      for (const handler of this.captured) {
        handler(event);
      }
    });
  }
}

describe("GroupsView", () => {
  it("prompts to add a workspace when there are no roots", () => {
    render(<GroupsView client={new MockWireClient()} active workspaceRoots={[]} runs={[]} />);
    expect(screen.getByText(/Add a workspace in Settings/i)).toBeTruthy();
  });

  it("clusters two repos on the same branch into one group with combined changes", async () => {
    const client = new PushableWireClient();
    render(<GroupsView client={client} active workspaceRoots={ROOTS} runs={[]} />);

    // Two separately-added repos that share a branch (the cross-repo change).
    client.push({
      kind: "git_overview",
      overview: {
        root: "C:/repos/Studios/api",
        repos: [status("C:/repos/Studios/api", "claude/feature-x", true)]
      }
    });
    client.push({
      kind: "git_overview",
      overview: {
        root: "C:/repos/Studios/web",
        repos: [status("C:/repos/Studios/web", "claude/feature-x", true)]
      }
    });

    const groupButton = await screen.findByRole("button", { name: /claude\/feature-x/ });
    expect(groupButton.textContent).toContain("2 repos");
    expect(groupButton.textContent).toContain("2 changed");
  });

  it("attributes a run to the group and shows it on expand, with a combined diff", async () => {
    const client = new PushableWireClient();
    render(
      <GroupsView
        client={client}
        active
        workspaceRoots={ROOTS}
        runs={[run("r1", "C:/repos/Studios/api", "Wire the endpoint")]}
      />
    );

    client.push({
      kind: "git_overview",
      overview: {
        root: "C:/repos/Studios/api",
        repos: [status("C:/repos/Studios/api", "claude/feature-x", true)]
      }
    });

    const groupButton = await screen.findByRole("button", { name: /claude\/feature-x/ });
    // The active-run pill shows on the summary.
    expect(groupButton.textContent).toContain("▶ 1");

    fireEvent.click(groupButton);

    // Expanded: the attributed run and the combined-diff section (the mock answers gitDiff).
    expect(await screen.findByText("Wire the endpoint")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(/Diff for api/)).toBeTruthy());
    expect(screen.getByText("Combined diff")).toBeTruthy();
  });

  it("hides a lone clean baseline repo behind a toggle", async () => {
    const client = new PushableWireClient();
    render(<GroupsView client={client} active workspaceRoots={ROOTS} runs={[]} />);

    client.push({
      kind: "git_overview",
      overview: {
        root: "C:/repos/Studios/api",
        repos: [status("C:/repos/Studios/api", "main", false)]
      }
    });

    // Nothing interesting → empty state, with a "show baseline" affordance.
    expect(await screen.findByText(/No grouped changes yet/i)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Show 1 baseline/i });
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: /main/ })).toBeTruthy();
  });
});
