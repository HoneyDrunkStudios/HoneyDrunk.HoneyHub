import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BridgeSettings } from "./BridgeSettings";
import type { PairingFactory } from "./settingsModel";

function fixedFactory(): PairingFactory {
  let counter = 0;
  return {
    deviceId: () => `device-${counter++}`,
    token: () => "one-time-token",
    now: () => "2026-06-07T12:00:00Z"
  };
}

describe("BridgeSettings", () => {
  it("pairs a device, shows the token once, then revokes it", () => {
    render(<BridgeSettings factory={fixedFactory()} />);

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

  it("surfaces an explicit error for a relative workspace root", () => {
    render(<BridgeSettings factory={fixedFactory()} />);

    fireEvent.change(screen.getByLabelText("Absolute path"), {
      target: { value: "relative/path" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add root" }));

    expect(screen.getByRole("alert").textContent).toMatch(/absolute/);
  });

  it("adds an absolute workspace root", () => {
    render(<BridgeSettings factory={fixedFactory()} />);

    fireEvent.change(screen.getByLabelText("Absolute path"), {
      target: { value: "/home/dev/work" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add root" }));

    const roots = screen.getByRole("list", { name: "Workspace roots" });
    expect(within(roots).getByText("/home/dev/work")).toBeTruthy();
  });
});
