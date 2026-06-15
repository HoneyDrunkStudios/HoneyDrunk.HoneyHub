import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { JobsView } from "./JobsView";

describe("JobsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("snapshots known jobs and processes when active", async () => {
    const client = new MockWireClient();
    render(<JobsView client={client} active />);

    // The mock scripts Claude up, Codex down, and two processes.
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("1/2 up")).toBeTruthy();
    expect(screen.getByText("claude.exe")).toBeTruthy();
    expect(screen.getByText("node.exe")).toBeTruthy();
    // Scheduled tasks surface too, including a failed one (non-zero last result).
    expect(screen.getByText("grid-agent-runner")).toBeTruthy();
    expect(screen.getByText("last: error 1")).toBeTruthy();
  });

  it("toggles the onboarding help with setup guidance", async () => {
    const client = new MockWireClient();
    render(<JobsView client={client} active />);
    await screen.findByText("Claude Code");
    expect(screen.queryByText(/Add a scheduled background job/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.getByText(/Add a scheduled background job/i)).toBeTruthy();
    // The schtasks example names the recognized convention.
    expect(screen.getByText(/schtasks \/create/)).toBeTruthy();
  });

  it("adds a custom job pattern and surfaces it as a known job", async () => {
    // In-memory Storage so the probe persists across the re-snapshot.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    });

    const client = new MockWireClient();
    const seen: Array<{ extraProbes?: Array<{ label: string }> } | undefined> = [];
    const original = client.listJobs.bind(client);
    client.listJobs = (options) => {
      seen.push(options);
      return original(options);
    };

    render(<JobsView client={client} active />);
    await screen.findByText("Claude Code");

    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    fireEvent.change(screen.getByPlaceholderText("My worker"), {
      target: { value: "Queue runner" }
    });
    fireEvent.change(screen.getByPlaceholderText("my-worker, queue-runner.js"), {
      target: { value: "queue-runner.js" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add job" }));

    // The probe was persisted and the next snapshot request carried it.
    expect(store.get("honeyhub.jobPatterns.v1")).toContain("Queue runner");
    await waitFor(() =>
      expect(seen.some((o) => o?.extraProbes?.some((p) => p.label === "Queue runner"))).toBe(true)
    );
    // The mock echoes user probes back as known jobs, so it surfaces in the Known jobs list.
    const knownList = document.querySelector("ul.jobs-known");
    if (knownList === null) {
      throw new Error("expected the known-jobs list to render");
    }
    await waitFor(() =>
      expect(within(knownList as HTMLElement).getByText("Queue runner")).toBeTruthy()
    );

    // Removing it (via the unique aria-labelled button in the probe list) drops the probe.
    fireEvent.click(screen.getByRole("button", { name: "Remove Queue runner" }));
    expect(store.get("honeyhub.jobPatterns.v1")).not.toContain("Queue runner");
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.listJobs.bind(client);
    client.listJobs = () => {
      calls += 1;
      return original();
    };
    render(<JobsView client={client} active={false} />);
    expect(calls).toBe(0);
  });

  it("surfaces a generic error when the snapshot fails", async () => {
    const client = new MockWireClient();
    client.listJobs = () => Promise.reject(new Error("C:/secret/path leaked"));
    render(<JobsView client={client} active />);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toBe("could not read local jobs"));
    expect(alert.textContent).not.toContain("secret");
  });
});
