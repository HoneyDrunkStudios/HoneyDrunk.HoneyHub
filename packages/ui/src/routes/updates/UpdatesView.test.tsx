import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackendCapability } from "@honeydrunk/honeyhub-types";
import { defaultClaudeCapabilities } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import { UpdatesView } from "./UpdatesView";

const CATALOG: BackendCapability[] = [
  {
    backend: "claude.local",
    program: "claude",
    available: true,
    capabilities: defaultClaudeCapabilities,
    models: [
      { id: "opus", label: "Claude Opus" },
      { id: "sonnet", label: "Claude Sonnet" }
    ],
    modelSource: "cli_alias"
  }
];

describe("UpdatesView", () => {
  it("shows the installed CLI version and the model list when active", async () => {
    const client = new MockWireClient();
    render(<UpdatesView client={client} active catalog={CATALOG} />);

    // The mock reports Claude installed at 1.4.0.
    expect(await screen.findByText("1.4.0")).toBeTruthy();
    expect(screen.getByText("Claude Opus")).toBeTruthy();
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.detectEnvironment.bind(client);
    client.detectEnvironment = () => {
      calls += 1;
      return original();
    };
    render(<UpdatesView client={client} active={false} catalog={CATALOG} />);
    expect(calls).toBe(0);
  });
});
