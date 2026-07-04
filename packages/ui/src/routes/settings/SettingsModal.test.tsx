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
    expect(within(list).getByLabelText("Runs")).toBeTruthy();
  });

  it("toggles a page off through onPagePrefsChange", () => {
    const { onPagePrefsChange } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    // Repositories is visible by default → clicking hides it.
    fireEvent.click(screen.getByLabelText("Repositories"));
    expect(onPagePrefsChange).toHaveBeenCalledWith({ repositories: false });
  });

  it("shows a default-hidden page toggle as off and turns it on", () => {
    const { onPagePrefsChange } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    const runs = screen.getByLabelText("Runs") as HTMLInputElement;
    expect(runs.checked).toBe(false);
    fireEvent.click(runs);
    expect(onPagePrefsChange).toHaveBeenCalledWith({ runs: true });
  });

  it("closes on backdrop click and on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reaches the Bridge section (device pairing)", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Bridge" }));
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });
});
