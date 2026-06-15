import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { HubView } from "./HubView";

function stubStorage(prefs: string, config?: string): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key === "honeyhub.connectors.v1") {
        return prefs;
      }
      if (key === "honeyhub.connectorConfig.v1") {
        return config ?? null;
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

describe("HubView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("nudges to Settings when nothing is enabled", () => {
    stubStorage("{}");
    const client = new MockWireClient();
    render(<HubView client={client} active onNavigate={() => undefined} />);
    expect(screen.getByText(/No connectors enabled yet/i)).toBeTruthy();
  });

  it("shows headline cards and navigates on click", async () => {
    stubStorage(
      '{"github":true,"servicebus":true,"sentry":true}',
      '{"sentry":{"org":"hd","project":"hh","token":"t"}}'
    );
    const client = new MockWireClient();
    const navad: string[] = [];
    render(
      <HubView client={client} active onNavigate={(v) => navad.push(v)} />
    );

    // Work card: the mock GitHub snapshot has 3 items.
    const workCard = await screen.findByText("Assigned work");
    const workButton = workCard.closest("button");
    expect(within(workButton as HTMLElement).getByText("3")).toBeTruthy();

    // Dead-letter card: mock Service Bus has a backlog of 3 and reads as a warning.
    const dlqButton = screen.getByText("Dead-letter").closest("button");
    expect(dlqButton?.className).toContain("tone-warn");

    // Unresolved errors card: mock Sentry has 2 issues.
    const sentryButton = screen.getByText("Unresolved errors").closest("button");
    await waitFor(() =>
      expect(within(sentryButton as HTMLElement).getByText("2")).toBeTruthy()
    );

    // Clicking a card jumps to its tab.
    fireEvent.click(workButton as HTMLElement);
    expect(navad).toContain("work");
  });
});
