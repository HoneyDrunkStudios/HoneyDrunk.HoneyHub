import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PairingSettings,
  ProvidersModelsSettings,
  WorkspaceRootsSettings
} from "./BridgeSettings";
import type { PairingFactory } from "./settingsModel";

function fixedFactory(): PairingFactory {
  let counter = 0;
  return {
    deviceId: () => `device-${counter++}`,
    token: () => "one-time-token",
    now: () => "2026-06-07T12:00:00Z"
  };
}

describe("PairingSettings", () => {
  it("pairs a device, shows the token once, then revokes it", () => {
    render(<PairingSettings factory={fixedFactory()} />);

    fireEvent.change(screen.getByLabelText("Device name"), {
      target: { value: "Pixel phone" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    // Token shown exactly once via the status region.
    expect(screen.getByText("one-time-token")).toBeTruthy();

    const devices = screen.getByRole("list", { name: "Paired devices" });
    expect(within(devices).getByText("Pixel phone")).toBeTruthy();

    // Acknowledge clears the one-time token.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("one-time-token")).toBeNull();

    fireEvent.click(within(devices).getByRole("button", { name: "Revoke" }));
    expect(within(devices).getByText("revoked")).toBeTruthy();
  });
});

describe("WorkspaceRootsSettings", () => {
  it("surfaces an explicit error for a relative workspace root", () => {
    render(<WorkspaceRootsSettings />);

    fireEvent.change(screen.getByLabelText("Or enter an absolute path"), {
      target: { value: "relative/path" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add root" }));

    expect(screen.getByRole("alert").textContent).toMatch(/absolute/);
  });

  it("adds an absolute workspace root", () => {
    render(<WorkspaceRootsSettings />);

    fireEvent.change(screen.getByLabelText("Or enter an absolute path"), {
      target: { value: "/home/dev/work" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add root" }));

    const roots = screen.getByRole("list", { name: "Workspace roots" });
    expect(within(roots).getByText("/home/dev/work")).toBeTruthy();
  });
});

describe("ProvidersModelsSettings", () => {
  it("renders backend toggles and enables a provider", () => {
    render(<ProvidersModelsSettings />);

    const toggles = screen.getAllByRole("checkbox");
    expect(toggles.length).toBeGreaterThan(0);

    // Providers start disabled (empty allowlist); toggling one enables it (uncontrolled state).
    const first = toggles[0] as HTMLInputElement;
    expect(first.checked).toBe(false);
    fireEvent.click(first);
    expect(first.checked).toBe(true);
  });
});
