import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { ObserveView } from "./ObserveView";

function stubPrefs(json: string, configJson?: string): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key === "honeyhub.connectors.v1") {
        return json;
      }
      if (key === "honeyhub.connectorConfig.v1") {
        return configJson ?? null;
      }
      return null;
    },
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0
  });
}

describe("ObserveView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("nudges to Settings when no observability connector is enabled", () => {
    stubPrefs("{}");
    let calls = 0;
    const client = new MockWireClient();
    const original = client.listServiceBus.bind(client);
    client.listServiceBus = () => {
      calls += 1;
      return original();
    };
    render(<ObserveView client={client} active />);
    expect(screen.getByText(/No observability connectors enabled/i)).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("with Service Bus enabled, shows entities and headlines the dead-letter total", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    // The mock scripts a queue with a dead-letter backlog and a subscription.
    expect(await screen.findByText("notify-queue")).toBeTruthy();
    expect(screen.getByText("telemetry/pulse-sub")).toBeTruthy();
    // The dead-letter total (3) is surfaced in the totals strip.
    const totals = document.querySelector(".sb-totals");
    expect(totals).not.toBeNull();
    await waitFor(() =>
      expect(within(totals as HTMLElement).getByText("3")).toBeTruthy()
    );
  });

  it("peeks messages for an entity (read-only) and shows them", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    // Wait for the table, then peek the queue.
    const queueCell = await screen.findByText("notify-queue");
    const row = queueCell.closest("tr");
    if (row === null) {
      throw new Error("expected the entity row");
    }
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Peek" }));

    // The mock returns two messages; the detail panel renders them, read-only.
    expect(await screen.findByText(/Read-only browse/i)).toBeTruthy();
    expect(screen.getByText('{"orderId":42}')).toBeTruthy();
    expect(screen.getByText("plain text message")).toBeTruthy();
  });

  it("resubmits dead-letter messages behind a confirm", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    // notify-queue has a dead-letter backlog → a DLQ peek button.
    const row = (await screen.findByText("notify-queue")).closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "DLQ" }));
    // The DLQ peek shows a dead-letter message + a Resubmit affordance.
    await screen.findByText(/Resubmit .* to source/i);

    // First click asks to confirm (no destructive action yet)…
    fireEvent.click(screen.getByRole("button", { name: /Resubmit .* to source/i }));
    const confirmBtn = screen.getByRole("button", { name: /Confirm resubmit/i });
    expect(confirmBtn).toBeTruthy();
    // …then confirming performs the move and reports it.
    fireEvent.click(confirmBtn);
    expect(await screen.findByText(/✓ Resubmitted/)).toBeTruthy();
  });

  it("purges an entity behind a confirm", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    const row = (await screen.findByText("notify-queue")).closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Peek" }));
    await screen.findByText(/Read-only browse/i);

    // Purge is confirm-gated: first click reveals Confirm purge, then it drains.
    fireEvent.click(screen.getByRole("button", { name: /Purge all/i }));
    const confirmBtn = screen.getByRole("button", { name: /Confirm purge/i });
    fireEvent.click(confirmBtn);
    expect(await screen.findByText(/✓ Purged/)).toBeTruthy();
  });

  it("sends a message via the compose form behind a confirm", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    const row = (await screen.findByText("notify-queue")).closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Peek" }));
    await screen.findByText(/Read-only browse/i);

    // Open the compose form, type a body, confirm.
    fireEvent.click(screen.getByRole("button", { name: "Send a message" }));
    fireEvent.change(screen.getByLabelText("Message body"), {
      target: { value: '{"orderId":99}' }
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm send/i }));
    expect(await screen.findByText(/✓ Sent to/)).toBeTruthy();
  });

  it("receives (consumes) a message behind a confirm", async () => {
    stubPrefs('{"servicebus":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    const row = (await screen.findByText("notify-queue")).closest("tr");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Peek" }));
    await screen.findByText(/Read-only browse/i);

    fireEvent.click(screen.getByRole("button", { name: "Receive one (remove)" }));
    const confirmBtn = screen.getByRole("button", { name: /Confirm receive/i });
    fireEvent.click(confirmBtn);
    expect(await screen.findByText(/✓ Received & removed/)).toBeTruthy();
  });

  it("shows Grafana 'not configured' when enabled without a base URL", async () => {
    stubPrefs('{"grafana":true}', "{}");
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);
    expect(await screen.findByText(/Not configured/i)).toBeTruthy();
  });

  it("shows Grafana health + dashboards when configured", async () => {
    stubPrefs('{"grafana":true}', '{"grafana":{"baseUrl":"https://g.example","token":"t"}}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);
    expect(await screen.findByText("Pulse Overview")).toBeTruthy();
    expect(screen.getByText("Traces (Tempo)")).toBeTruthy();
    // The deep-link points at the configured instance.
    const link = screen.getByText("Pulse Overview").closest("a");
    expect(link?.getAttribute("href")).toContain("https://g.example/d/");
  });

  it("shows Sentry unresolved issues when configured", async () => {
    stubPrefs(
      '{"sentry":true}',
      '{"sentry":{"org":"honeydrunk","project":"honeyhub","token":"t"}}'
    );
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);
    expect(
      await screen.findByText("TypeError: cannot read properties of undefined")
    ).toBeTruthy();
    expect(screen.getByText("42 events")).toBeTruthy();
  });

  it("shows Sentry 'not configured' when enabled without org/project/token", async () => {
    stubPrefs('{"sentry":true}', "{}");
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);
    expect(await screen.findByText(/Not configured/i)).toBeTruthy();
  });

  it("with Key Vault enabled, lists the default subscription's vaults", async () => {
    stubPrefs('{"keyvault":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    // Both subscriptions appear as checkboxes; the default is tagged + pre-selected.
    expect(await screen.findByRole("checkbox", { name: /HoneyDrunk Dev/ })).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    // The default subscription's vaults are listed; Prod's vault is not (not selected yet).
    expect(await screen.findByText("kv-honeydrunk-dev")).toBeTruthy();
    expect(screen.getByText("kv-automation-dev")).toBeTruthy();
    expect(screen.queryByText("kv-honeydrunk-prod")).toBeNull();
  });

  it("selecting another subscription lists its vaults too", async () => {
    stubPrefs('{"keyvault":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    await screen.findByText("kv-honeydrunk-dev");
    fireEvent.click(screen.getByRole("checkbox", { name: /HoneyDrunk Prod/ }));
    expect(await screen.findByText("kv-honeydrunk-prod")).toBeTruthy();
  });

  it("warns about a selected subscription it could not read", async () => {
    stubPrefs('{"keyvault":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    await screen.findByText("kv-honeydrunk-dev");
    // The "Locked" subscription has no vaults the mock can read → a partial-failure warning,
    // not a silent empty list.
    fireEvent.click(screen.getByRole("checkbox", { name: /HoneyDrunk Locked/ }));
    expect(await screen.findByText(/Could not read 1 subscription/)).toBeTruthy();
  });

  it("filters the vault list by name", async () => {
    stubPrefs('{"keyvault":true}');
    const client = new MockWireClient();
    render(<ObserveView client={client} active />);

    await screen.findByText("kv-automation-dev");
    fireEvent.change(screen.getByLabelText("Filter Key Vaults"), {
      target: { value: "automation" }
    });
    expect(screen.getByText("kv-automation-dev")).toBeTruthy();
    expect(screen.queryByText("kv-honeydrunk-dev")).toBeNull();
  });
});
