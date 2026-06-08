import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { AgentsView } from "./AgentsView";

describe("AgentsView", () => {
  it("discovers and lists agents grouped by backend", async () => {
    const client = new MockWireClient();
    render(<AgentsView client={client} active />);

    // The mock returns one Claude subagent and one Copilot agent.
    expect(await screen.findByText("Code Reviewer")).toBeTruthy();
    expect(screen.getByText("release agent")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Copilot")).toBeTruthy();
    // Metadata is surfaced: model + relative source path (no absolute prefix) +
    // the workspace label (basename, not an absolute path).
    expect(screen.getByText("claude-opus")).toBeTruthy();
    expect(screen.getByText(".claude/agents/code-reviewer.md")).toBeTruthy();
    expect(screen.getAllByText("demo").length).toBeGreaterThan(0);
    // No absolute filesystem path is rendered anywhere.
    expect(document.body.textContent).not.toContain("/work/demo");
    // The local-only/read-only posture is stated.
    expect(screen.getByText(/Read-only/i)).toBeTruthy();
  });

  it("shows a generic error and not the loading copy when discovery fails", async () => {
    const client = new MockWireClient();
    client.discoverAgents = () => Promise.reject(new Error("/Users/secret/path leaked"));

    render(<AgentsView client={client} active />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("could not discover agents");
    expect(alert.textContent).not.toContain("secret");
    expect(screen.queryByText("Discovering agents…")).toBeNull();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.discoverAgents.bind(client);
    client.discoverAgents = (root?: string) => {
      calls += 1;
      return original(root);
    };

    render(<AgentsView client={client} active={false} />);
    expect(calls).toBe(0);
  });
});
