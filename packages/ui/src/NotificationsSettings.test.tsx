import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { defaultNotificationPrefs } from "./notifications";

// osNotify is the browser Web Notifications boundary (coverage-excluded); mock it so we can
// drive each permission branch deterministically.
const mocks = vi.hoisted(() => ({
  permission: { value: "default" as string },
  request: vi.fn(async () => "granted" as string)
}));
vi.mock("./osNotify", () => ({
  notificationPermission: () => mocks.permission.value,
  requestNotificationPermission: mocks.request
}));

import { NotificationsSettings } from "./NotificationsSettings";

describe("NotificationsSettings", () => {
  beforeEach(() => {
    mocks.permission.value = "default";
    mocks.request.mockClear();
  });

  it("toggles a trigger type and reports the flipped prefs", () => {
    const onChange = vi.fn();
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Mentioned/i }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultNotificationPrefs, workMentioned: false });
  });

  it("toggles the Key Vault expiring alert", () => {
    const onChange = vi.fn();
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Key Vault secret expiring/i }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultNotificationPrefs, secretExpiring: false });
  });

  it("edits the expiry-window days and clamps out-of-range input", () => {
    const onChange = vi.fn();
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={onChange} />);
    const field = screen.getByLabelText(/Days before expiry to alert/i);
    fireEvent.change(field, { target: { value: "14" } });
    expect(onChange).toHaveBeenCalledWith({ ...defaultNotificationPrefs, secretExpiryDays: 14 });
    // Above the max clamps to 365.
    fireEvent.change(field, { target: { value: "9999" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...defaultNotificationPrefs, secretExpiryDays: 365 });
  });

  it("shows the Enable button when permission is default and grants on click", async () => {
    const onChange = vi.fn();
    render(
      <NotificationsSettings prefs={{ ...defaultNotificationPrefs, desktop: false }} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Enable desktop notifications/i }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({ ...defaultNotificationPrefs, desktop: true });
  });

  it("reports the granted note and hides the Enable button", () => {
    mocks.permission.value = "granted";
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={vi.fn()} />);
    expect(screen.getByText(/Desktop notifications are allowed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enable desktop/i })).toBeNull();
  });

  it("disables the desktop toggle when blocked", () => {
    mocks.permission.value = "denied";
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={vi.fn()} />);
    expect(screen.getByText(/blocked in your browser/i)).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: /Desktop notifications/i }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it("reports the unsupported note", () => {
    mocks.permission.value = "unsupported";
    render(<NotificationsSettings prefs={defaultNotificationPrefs} onChange={vi.fn()} />);
    expect(screen.getByText(/no desktop notifications/i)).toBeTruthy();
  });
});
