import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEventPayload } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import type { WireClient, WireEventHandler } from "../../wire/client";
import { ServiceBusConnectionsPanel } from "./ServiceBusConnectionsPanel";

// The jsdom localStorage stub is read-only (setItem throws), so swap in a fresh in-memory
// Storage per test, exactly like serviceBusConnections.test.ts. The panel both loads from and
// saves to localStorage, so a real round-trip store is required.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

// The namespace the saved connections use. Because the panel sends `connection.namespace` as the
// wire `namespace` and filters incoming events by the same FQDN, scripting it as a full FQDN keeps
// the mock's echoed events matching the panel's filter.
const NS = "hd-bus-dev.servicebus.windows.net";

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Save one connection through the Add-connection form so the rest of the test can drive it. */
function addConnection(label = "Dev", namespace = NS): void {
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: label } });
  fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: namespace } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
}

/** Expand the (single) connection panel so its body + entities render. */
async function openConnectionAndEntities(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Dev/ }));
  // Toggling open auto-lists entities; the mock echoes a queue + topic + subscription.
  expect(await screen.findByText("notify-queue")).toBeTruthy();
}

describe("ServiceBusConnectionsPanel", () => {
  it("shows the empty state when there are no saved connections", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    expect(screen.getByText(/No saved connections/i)).toBeTruthy();
  });

  it("saves a new AAD connection and persists it to localStorage", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    addConnection();
    // The connection renders with its label, namespace, and an Azure AD auth badge.
    expect(screen.getByText("Dev")).toBeTruthy();
    expect(screen.getByText("Azure AD")).toBeTruthy();
    const raw = globalThis.localStorage.getItem("honeyhub.serviceBusConnections.v1");
    expect(raw).toContain("hd-bus-dev.servicebus.windows.net");
  });

  it("shows a form error when the connection draft is invalid, then can cancel", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    // No name + no namespace -> connectionFromDraft throws, surfaced as an alert.
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("alert").textContent).toMatch(/name is required/i);
    // Cancel closes the form.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Connection name")).toBeNull();
  });

  it("saves a SAS connection string and shows the connection-string badge", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "SasConn" } });
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: NS } });
    fireEvent.change(screen.getByLabelText("Connection string"), {
      target: { value: "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=k=" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByText("connection string")).toBeTruthy();
  });

  it("edits an existing connection (Update connection)", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    addConnection();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // The form is now in edit mode (Update button), pre-filled with the label.
    const nameField = screen.getByLabelText("Connection name") as HTMLInputElement;
    expect(nameField.value).toBe("Dev");
    fireEvent.change(nameField, { target: { value: "Dev Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Update connection" }));
    expect(screen.getByText("Dev Renamed")).toBeTruthy();
  });

  it("removes a connection through the confirm flow (and can cancel removal)", () => {
    render(<ServiceBusConnectionsPanel client={new MockWireClient()} active />);
    addConnection();
    // Cancel path first.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Dev")).toBeTruthy();
    // Confirm path removes it, returning to the empty state.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(screen.getByText(/No saved connections/i)).toBeTruthy();
  });

  it("opens a connection, lists entities, and renders queues/topics/subscriptions", async () => {
    const client = new MockWireClient();
    const listSpy = vi.spyOn(client, "listServiceBusEntities");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    expect(listSpy).toHaveBeenCalledWith({ namespace: NS });
    expect(screen.getByText("notify-queue")).toBeTruthy();
    expect(screen.getByText("telemetry")).toBeTruthy();
    expect(screen.getByText("pulse-sub")).toBeTruthy();
    // The queue has a DLQ backlog badge.
    expect(screen.getByText(/3 DLQ/)).toBeTruthy();

    // Refresh entities button re-lists.
    fireEvent.click(screen.getByRole("button", { name: "Refresh entities" }));
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("renders the unavailable state when entities come back not available", async () => {
    // Use a fake client that exposes the captured subscribe handler so we can craft events.
    let handler: WireEventHandler | undefined;
    const client = new MockWireClient();
    const realSubscribe = client.subscribe.bind(client);
    vi.spyOn(client, "subscribe").mockImplementation((h: WireEventHandler) => {
      handler = h;
      return realSubscribe(h);
    });
    // Make listServiceBusEntities a no-op so only our crafted event drives state.
    vi.spyOn(client, "listServiceBusEntities").mockResolvedValue(undefined);

    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    fireEvent.click(screen.getByRole("button", { name: /Dev/ }));

    const event: BridgeEvent = {
      id: "e1",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "2026-06-21T00:00:00.000Z",
      payload: {
        kind: "service_bus_entities",
        entities: { available: false, namespace: NS, error: "az login required", queues: [], topics: [] }
      } as BridgeEventPayload
    };
    handler?.(event);
    expect(await screen.findByText("az login required")).toBeTruthy();
  });

  it("peeks a queue, then sends, receives, and purges against it", async () => {
    const client = new MockWireClient();
    const peekSpy = vi.spyOn(client, "peekServiceBus");
    const sendSpy = vi.spyOn(client, "sendServiceBus");
    const receiveSpy = vi.spyOn(client, "receiveServiceBus");
    const purgeSpy = vi.spyOn(client, "purgeServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    // Peek the queue (non-DLQ). The mock echoes two scripted messages.
    const queueRow = screen.getByText("notify-queue").closest("li") as HTMLElement;
    fireEvent.click(within(queueRow).getByRole("button", { name: "Peek" }));
    expect(peekSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NS, entity: "notify-queue", deadLetter: false, count: 20 })
    );
    expect(await screen.findByText(/order\.created/)).toBeTruthy();

    // Send a message (compose -> confirm).
    fireEvent.click(screen.getByRole("button", { name: "Send a message" }));
    fireEvent.change(screen.getByLabelText("Message body"), { target: { value: '{"orderId":1}' } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm send to/ }));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NS, entity: "notify-queue", body: '{"orderId":1}' })
    );
    expect(await screen.findByText(/Sent to notify-queue/)).toBeTruthy();

    // Receive one (confirm-gated).
    fireEvent.click(screen.getByRole("button", { name: "Receive one (remove)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm receive" }));
    expect(receiveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NS, entity: "notify-queue", deadLetter: false })
    );

    // Purge all (confirm-gated).
    fireEvent.click(screen.getByRole("button", { name: "Purge all" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm purge" }));
    expect(purgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NS, entity: "notify-queue", deadLetter: false })
    );
  });

  it("peeks a DLQ and resubmits dead-letter messages", async () => {
    const client = new MockWireClient();
    const resubmitSpy = vi.spyOn(client, "resubmitDeadLetter");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    // The queue shows a DLQ button because it has a dead-letter backlog.
    const queueRow = screen.getByText("notify-queue").closest("li") as HTMLElement;
    fireEvent.click(within(queueRow).getByRole("button", { name: "DLQ" }));
    // The DLQ peek echoes a dead-letter message.
    expect(await screen.findByText(/MaxDeliveryCountExceeded/)).toBeTruthy();

    // Resubmit (confirm-gated).
    fireEvent.click(screen.getByRole("button", { name: /Resubmit .* to source/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm resubmit" }));
    expect(resubmitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: NS, entity: "notify-queue", count: 1 })
    );
    expect(await screen.findByText(/Resubmitted 1 message/)).toBeTruthy();
  });

  it("peeks a subscription and closes the peek detail", async () => {
    const client = new MockWireClient();
    const peekSpy = vi.spyOn(client, "peekServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    const subRow = screen.getByText("pulse-sub").closest("li") as HTMLElement;
    fireEvent.click(within(subRow).getByRole("button", { name: "Peek" }));
    expect(peekSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: NS,
        entity: "telemetry",
        subscription: "pulse-sub",
        deadLetter: false
      })
    );
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).toBeNull());
  });

  it("creates a queue, a topic, and a subscription, and shows manage feedback", async () => {
    const client = new MockWireClient();
    const manageSpy = vi.spyOn(client, "manageServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    fireEvent.change(screen.getByLabelText("New queue name"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Create queue" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "create", entityKind: "queue", entity: "orders" })
    );
    // The manage feedback line renders on success.
    expect(await screen.findByText(/created? queue orders/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New topic name"), { target: { value: "events" } });
    fireEvent.click(screen.getByRole("button", { name: "Create topic" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "create", entityKind: "topic", entity: "events" })
    );

    fireEvent.change(screen.getByLabelText("New subscription on telemetry"), {
      target: { value: "audit-sub" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add subscription" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "create",
        entityKind: "subscription",
        entity: "telemetry",
        subscription: "audit-sub"
      })
    );
  });

  it("deletes a queue through the confirm flow", async () => {
    const client = new MockWireClient();
    const manageSpy = vi.spyOn(client, "manageServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    const queueRow = screen.getByText("notify-queue").closest("li") as HTMLElement;
    fireEvent.click(within(queueRow).getByRole("button", { name: "Delete" }));
    // Cancel first to cover that branch.
    fireEvent.click(within(queueRow).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(queueRow).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(queueRow).getByRole("button", { name: "Confirm delete" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "delete", entityKind: "queue", entity: "notify-queue" })
    );
  });

  it("edits queue properties through the props editor", async () => {
    const client = new MockWireClient();
    const manageSpy = vi.spyOn(client, "manageServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    const queueRow = screen.getByText("notify-queue").closest("li") as HTMLElement;
    fireEvent.click(within(queueRow).getByRole("button", { name: "Edit" }));

    // The props editor exposes queue-only fields. Change a couple, toggle the checkbox, set status.
    fireEvent.change(within(queueRow).getByRole("spinbutton", { name: "Max size (MB)" }), {
      target: { value: "2048" }
    });
    fireEvent.change(within(queueRow).getByRole("spinbutton", { name: "Max delivery count" }), {
      target: { value: "5" }
    });
    fireEvent.change(within(queueRow).getByRole("spinbutton", { name: "Default TTL (s)" }), {
      target: { value: "60" }
    });
    fireEvent.click(within(queueRow).getByRole("checkbox"));
    fireEvent.change(within(queueRow).getByRole("combobox"), { target: { value: "Disabled" } });

    fireEvent.click(within(queueRow).getByRole("button", { name: "Save properties" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "update",
        entityKind: "queue",
        entity: "notify-queue",
        props: expect.objectContaining({
          maxSizeMb: 2048,
          maxDeliveryCount: 5,
          defaultTtlSeconds: 60,
          deadLetterOnExpiration: true,
          status: "Disabled"
        })
      })
    );
  });

  it("edits topic properties (topic-only field set) and can cancel the editor", async () => {
    const client = new MockWireClient();
    const manageSpy = vi.spyOn(client, "manageServiceBus");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    await openConnectionAndEntities();

    const topicRow = screen.getByText("telemetry").closest("li") as HTMLElement;
    // The topic row's own Edit is the first Edit-labeled button within it.
    const topicEdit = within(topicRow).getAllByRole("button", { name: "Edit" })[0] as HTMLElement;
    fireEvent.click(topicEdit);
    // Topic has Max size + TTL but no delivery-count / checkbox.
    expect(within(topicRow).getByRole("spinbutton", { name: "Max size (MB)" })).toBeTruthy();
    expect(within(topicRow).queryByRole("spinbutton", { name: "Max delivery count" })).toBeNull();

    fireEvent.change(within(topicRow).getByRole("spinbutton", { name: "Max size (MB)" }), {
      target: { value: "4096" }
    });
    fireEvent.click(within(topicRow).getByRole("button", { name: "Save properties" }));
    expect(manageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "update", entityKind: "topic", entity: "telemetry" })
    );
  });

  it("does not auto-list while the panel body is collapsed (lazy load)", () => {
    const client = new MockWireClient();
    const listSpy = vi.spyOn(client, "listServiceBusEntities");
    render(<ServiceBusConnectionsPanel client={client} active />);
    addConnection();
    // Connection saved but not expanded -> no entity query yet.
    expect(listSpy).not.toHaveBeenCalled();
  });
});
