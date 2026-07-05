import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal, type SettingsModalProps } from "./SettingsModal";
import { emptyBridgeSettings } from "../../settingsModel";
import { defaultNotificationPrefs } from "../../notifications";
import { MockWireClient } from "../../wire/mockClient";
import type { PagePrefs } from "../../pagePrefs";

function renderModal(overrides: Partial<SettingsModalProps> = {}) {
  const onPagePrefsChange = vi.fn();
  const onClose = vi.fn();
  const props: SettingsModalProps = {
    settings: emptyBridgeSettings,
    onSettingsChange: vi.fn(),
    catalog: [],
    client: new MockWireClient(),
    plans: {},
    onPlansChange: vi.fn(),
    theme: "honey",
    onThemeChange: vi.fn(),
    notificationPrefs: defaultNotificationPrefs,
    onNotificationPrefsChange: vi.fn(),
    pagePrefs: {} as PagePrefs,
    onPagePrefsChange,
    onClose,
    ...overrides
  };
  render(<SettingsModal {...props} />);
  return { onPagePrefsChange, onClose };
}

describe("SettingsModal", () => {
  it("renders as a dialog with a Settings heading and General (theme) first", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // General section shows the theme picker by default.
    expect(screen.getByRole("heading", { name: "Theme" })).toBeTruthy();
  });

  it("switches to the Pages section and lists page toggles", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    const list = screen.getByRole("list", { name: "Toggle pages" });
    expect(within(list).getByLabelText("Repositories")).toBeTruthy();
    expect(within(list).getByLabelText("Groups")).toBeTruthy();
  });

  it("toggles a page off through onPagePrefsChange", () => {
    const { onPagePrefsChange } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    // Repositories is visible by default → clicking hides it.
    fireEvent.click(screen.getByLabelText("Repositories"));
    expect(onPagePrefsChange).toHaveBeenCalledWith({ repositories: false });
  });

  it("shows every toggleable page as visible by default and turns one off", () => {
    const { onPagePrefsChange } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    // No default-hidden pages remain: Groups starts checked (visible), and clicking hides it.
    const groups = screen.getByLabelText("Groups") as HTMLInputElement;
    expect(groups.checked).toBe(true);
    fireEvent.click(groups);
    expect(onPagePrefsChange).toHaveBeenCalledWith({ groups: false });
  });

  it("closes on backdrop click and on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("lists every top-level settings section in the left nav", () => {
    renderModal();
    for (const label of [
      "General",
      "Pages",
      "Pairing & Devices",
      "Workspace Roots",
      "Providers & Models",
      "Connectors",
      "Plans & Costs",
      "Notifications"
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("reaches the Pairing & Devices section (device pairing)", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pairing & Devices" }));
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });

  it("reaches the Workspace Roots section", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Workspace Roots" }));
    expect(screen.getByRole("list", { name: "Workspace Roots" })).toBeTruthy();
    expect(screen.getByLabelText("Or enter an absolute path")).toBeTruthy();
  });

  it("reaches the Providers & Models section", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Providers & Models" }));
    expect(screen.getByRole("heading", { name: "Providers & Models" })).toBeTruthy();
    // The backend toggles render (at least one provider checkbox).
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0);
  });

  it("reaches the Plans & Costs section", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Plans & Costs" }));
    expect(screen.getByLabelText("Claude Code plan")).toBeTruthy();
  });

  it("reaches the Notifications section", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    // The notifications settings surface renders (its heading names the section).
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
  });

  it("closes on the header close (✕) button", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
