import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RoadmapSnapshot } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import type { WireClient, WireEventHandler } from "../../wire/client";
import { PlanView } from "./PlanView";

describe("PlanView", () => {
  it("renders lanes with the next item from the roadmap snapshot", async () => {
    const client = new MockWireClient();
    render(<PlanView client={client} active />);

    // The mock scripts the three lanes; each surfaces its Next item.
    expect(await screen.findByText("HoneyHub")).toBeTruthy();
    expect(screen.getByText("NovOutbox")).toBeTruthy();
    expect(screen.getByText("Curiosities")).toBeTruthy();
    expect(screen.getByText("reviewed 2026-06-13")).toBeTruthy();
    // A found roadmap offers Pull latest (git ff-only sync).
    expect(screen.getByRole("button", { name: "Pull latest" })).toBeTruthy();

    // The HoneyHub lane's Next is its first non-blocked item.
    const honeyhub = screen.getByText("HoneyHub").closest(".plan-lane") as HTMLElement;
    expect(within(honeyhub).getByText("Next")).toBeTruthy();
    // "Launch checkpoint" appears in both the Next box and the ranked list.
    expect(within(honeyhub).getAllByText("Launch checkpoint").length).toBeGreaterThan(0);
    // The blocked item is marked.
    expect(within(honeyhub).getByText(/blocked by #1/)).toBeTruthy();
  });

  it("shows directions + create flow when no Architecture repo is found", async () => {
    // A controllable client: roadmap() reports found:false; scaffoldArchitecture() emits a
    // freshly-created found snapshot — both through the same subscribe handler set.
    const client = new MockWireClient();
    const handlers = new Set<WireEventHandler>();
    const emit = (roadmap: RoadmapSnapshot) =>
      handlers.forEach((handler) =>
        handler({
          id: "e",
          sessionId: "",
          runId: "",
          sequence: 0,
          createdAt: "t",
          payload: { kind: "roadmap", roadmap }
        })
      );
    const stub = client as unknown as WireClient;
    stub.subscribe = (handler: WireEventHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    };
    stub.roadmap = () => {
      emit({ found: false, source: "", lanes: [] });
      return Promise.resolve();
    };
    stub.scaffoldArchitecture = () => {
      emit({
        found: true,
        source: "(scaffolded)",
        lanes: [
          {
            lane: "Example",
            items: [
              { rank: 1, lane: "Example", item: "First priority", kind: "task", status: "Planned", due: "-", phase: "-" }
            ]
          }
        ]
      });
      return Promise.resolve();
    };

    render(<PlanView client={stub} active />);
    expect(await screen.findByText(/reads a HoneyDrunk/i)).toBeTruthy();
    expect(screen.getByText("initiatives/current-focus.md")).toBeTruthy();

    // Clicking Create scaffolds → the board renders the new lane.
    fireEvent.click(screen.getByRole("button", { name: "Create Architecture repo" }));
    await waitFor(() => expect(screen.getByText("Example")).toBeTruthy());
    expect(screen.getByText("First priority")).toBeTruthy();
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.roadmap.bind(client);
    client.roadmap = () => {
      calls += 1;
      return original();
    };
    render(<PlanView client={client} active={false} />);
    expect(calls).toBe(0);
  });
});
