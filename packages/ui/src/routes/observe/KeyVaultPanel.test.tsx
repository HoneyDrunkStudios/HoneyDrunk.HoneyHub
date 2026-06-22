import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { KeyVaultPanel } from "./KeyVaultPanel";

// The panel reads/writes a remembered subscription selection in localStorage; keep tests isolated.
afterEach(() => {
  globalThis.localStorage?.clear();
});

/** Expand the scripted dev vault and return its object-list <li> elements' container row finder. */
async function expandDevVault(): Promise<HTMLElement> {
  const client = new MockWireClient();
  render(<KeyVaultPanel client={client} active />);
  // The default subscription (dev) is pre-selected, so its vaults list automatically.
  const vaultButton = await screen.findByRole("button", { name: /kv-honeydrunk-dev/ });
  fireEvent.click(vaultButton);
  // Wait for the expanded contents to arrive.
  await screen.findByText("db-password");
  return vaultButton;
}

describe("KeyVaultPanel", () => {
  it("lists the default subscription's vaults", async () => {
    const client = new MockWireClient();
    render(<KeyVaultPanel client={client} active />);
    expect(await screen.findByText("kv-honeydrunk-dev")).toBeTruthy();
    expect(screen.getByText("kv-automation-dev")).toBeTruthy();
  });

  it("expands a vault to show its secrets, keys, and certificates", async () => {
    await expandDevVault();
    // A secret, a key, and a certificate from the scripted vault.
    expect(screen.getByText("db-password")).toBeTruthy();
    expect(screen.getByText("signing-key")).toBeTruthy();
    expect(screen.getByText("tls-cert")).toBeTruthy();
    // The disabled secret is tagged.
    const disabledRow = screen.getByText("legacy-token").closest("li") as HTMLElement;
    expect(within(disabledRow).getByText("disabled")).toBeTruthy();
    // Only secrets are revealable: keys and certificates have no Reveal button.
    const keyRow = screen.getByText("signing-key").closest("li") as HTMLElement;
    expect(within(keyRow).queryByRole("button", { name: "Reveal" })).toBeNull();
    const certRow = screen.getByText("tls-cert").closest("li") as HTMLElement;
    expect(within(certRow).queryByRole("button", { name: "Reveal" })).toBeNull();
  });

  it("ignores a stale reveal that resolves after collapse and re-expand", async () => {
    const client = new MockWireClient();
    client.deferReveals = true; // hold the reveal response so we can collapse/re-expand first
    render(<KeyVaultPanel client={client} active />);

    const vaultButton = await screen.findByRole("button", { name: /kv-honeydrunk-dev/ });
    fireEvent.click(vaultButton);
    const secretRow = (await screen.findByText("db-password")).closest("li") as HTMLElement;
    fireEvent.click(within(secretRow).getByRole("button", { name: "Reveal" }));

    // Collapse, then re-expand the same vault while the reveal is still in flight.
    fireEvent.click(screen.getByRole("button", { name: /kv-honeydrunk-dev/ }));
    fireEvent.click(await screen.findByRole("button", { name: /kv-honeydrunk-dev/ }));
    await screen.findByText("db-password");

    // The stale reveal now resolves; it must NOT repopulate the value in the fresh expansion.
    client.flushReveals();
    expect(screen.queryByText("demo-value-for-db-password")).toBeNull();
  });

  it("clears a revealed value when the subscription selection changes", async () => {
    const client = new MockWireClient();
    render(<KeyVaultPanel client={client} active />);
    fireEvent.click(await screen.findByRole("button", { name: /kv-honeydrunk-dev/ }));
    const secretRow = (await screen.findByText("db-password")).closest("li") as HTMLElement;
    fireEvent.click(within(secretRow).getByRole("button", { name: "Reveal" }));
    await screen.findByText("demo-value-for-db-password");

    // Changing the selection reloads the vault list, which must drop the revealed value.
    fireEvent.click(screen.getByRole("checkbox", { name: /HoneyDrunk Prod/ }));
    await waitFor(() => expect(screen.queryByText("demo-value-for-db-password")).toBeNull());
  });

  it("flags a past-dated secret as expired", async () => {
    await expandDevVault();
    // db-password expires 2026-01-15, which is in the past for any realistic run date.
    expect(screen.getByText(/expired 2026-01-15/)).toBeTruthy();
  });

  it("reveals a secret value on demand and hides it again", async () => {
    await expandDevVault();
    const secretRow = screen.getByText("db-password").closest("li") as HTMLElement;

    fireEvent.click(within(secretRow).getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("demo-value-for-db-password")).toBeTruthy();

    fireEvent.click(within(secretRow).getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("demo-value-for-db-password")).toBeNull();
  });

  it("filters the expanded vault's contents", async () => {
    await expandDevVault();
    fireEvent.change(screen.getByLabelText(/Filter kv-honeydrunk-dev contents/), {
      target: { value: "signing" }
    });
    expect(screen.getByText("signing-key")).toBeTruthy();
    expect(screen.queryByText("db-password")).toBeNull();
  });
});
