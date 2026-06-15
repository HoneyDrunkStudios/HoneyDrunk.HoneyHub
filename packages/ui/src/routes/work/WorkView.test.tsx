import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { WorkView } from "./WorkView";

function stubPrefs(json: string): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "honeyhub.connectors.v1" ? json : null),
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0
  });
}

describe("WorkView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("nudges to Settings when no work connector is enabled", () => {
    stubPrefs("{}");
    let calls = 0;
    const client = new MockWireClient();
    const original = client.listWork.bind(client);
    client.listWork = (sources) => {
      calls += 1;
      return original(sources);
    };
    render(<WorkView client={client} active />);
    expect(screen.getByText(/No work connectors enabled/i)).toBeTruthy();
    // With nothing enabled it must not query the host.
    expect(calls).toBe(0);
  });

  it("with GitHub enabled, shows items split by category and filters them", async () => {
    stubPrefs('{"github":true}');
    const client = new MockWireClient();
    render(<WorkView client={client} active />);

    // The mock scripts one assigned issue, one authored PR, one review request.
    expect(await screen.findByText("Wire the work hub")).toBeTruthy();
    const assigned = screen.getByRole("heading", { name: "Assigned" }).closest(".work-group");
    expect(assigned).not.toBeNull();
    expect(within(assigned as HTMLElement).getByText("Wire the work hub")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Authored" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review requested" })).toBeTruthy();

    // Filtering narrows to a matching item.
    fireEvent.change(screen.getByLabelText("Filter work items"), {
      target: { value: "ADR-0091" }
    });
    await waitFor(() => expect(screen.queryByText("Wire the work hub")).toBeNull());
    expect(screen.getByText("ADR-0091 mobile pairing")).toBeTruthy();
  });

  it("merges multiple enabled connectors (GitHub + ADO) into one hub", async () => {
    stubPrefs('{"github":true,"ado":true}');
    const client = new MockWireClient();
    const seen: string[][] = [];
    const original = client.listWork.bind(client);
    client.listWork = (sources) => {
      seen.push(sources);
      return original(sources);
    };
    render(<WorkView client={client} active />);

    // Both sources' items land in the same hub.
    expect(await screen.findByText("Ship the observability hub")).toBeTruthy();
    expect(screen.getByText("Wire the work hub")).toBeTruthy();
    // Both connector ids were requested.
    expect(seen.some((s) => s.includes("github") && s.includes("ado"))).toBe(true);
  });
});
