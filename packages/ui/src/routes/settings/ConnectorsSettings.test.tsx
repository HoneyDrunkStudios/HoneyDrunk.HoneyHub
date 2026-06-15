import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { ConnectorsSettings } from "./ConnectorsSettings";

function grafanaRow(): HTMLElement {
  const row = screen.getByText("Grafana (traces / metrics / logs)").closest("li");
  if (row === null) {
    throw new Error("expected the Grafana connector row");
  }
  return row;
}

describe("ConnectorsSettings — Test connection", () => {
  it("reports success when the configured connector responds", async () => {
    const client = new MockWireClient();
    render(<ConnectorsSettings client={client} />);
    const row = grafanaRow();
    // Grafana's only non-secret field is the Base URL.
    fireEvent.change(within(row).getByRole("textbox"), {
      target: { value: "https://grafana.example.com" }
    });
    fireEvent.click(within(row).getByRole("button", { name: "Test" }));
    // The mock reflects config state → available with a version.
    expect(await within(row).findByText(/✓ Connected/)).toBeTruthy();
  });

  it("reports the error when the connector is not configured", async () => {
    const client = new MockWireClient();
    render(<ConnectorsSettings client={client} />);
    const row = grafanaRow();
    // Test with an empty base URL → the mock returns "not configured".
    fireEvent.click(within(row).getByRole("button", { name: "Test" }));
    const status = await within(row).findByRole("status");
    expect(status.textContent).toContain("✗");
    expect(status.textContent?.toLowerCase()).toContain("not configured");
  });

  it("offers no Test button without a client", () => {
    render(<ConnectorsSettings />);
    const row = grafanaRow();
    expect(within(row).queryByRole("button", { name: "Test" })).toBeNull();
  });
});
