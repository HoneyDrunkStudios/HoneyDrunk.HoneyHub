import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HiveNav, type HiveNavItem, type HiveNavProps } from "./HiveNav";

const icon = <svg data-testid="icon" />;

// The full honeycomb: primary views (hub, spend, coaching, work) plus the config/trust surfaces
// (settings, updates, alerts) — all hexes now. Coaching exercises the pagePrefs filter.
const ITEMS: HiveNavItem[] = [
  { view: "hub", label: "Hub", icon },
  { view: "spend", label: "Spend", icon },
  { view: "coaching", label: "Coaching", icon },
  { view: "work", label: "Work", icon },
  { view: "settings", label: "Settings", icon },
  { view: "updates", label: "Updates", icon },
  { view: "notifications", label: "Alerts", icon }
];

function renderHive(overrides: Partial<HiveNavProps> = {}) {
  const onSelect = vi.fn();
  const props: HiveNavProps = {
    items: ITEMS,
    view: "hub",
    onSelect,
    unread: 0,
    pagePrefs: {},
    connected: false,
    bridgeUrl: "",
    onBridgeUrl: vi.fn(),
    onConnect: vi.fn(),
    ...overrides
  };
  render(<HiveNav {...props} />);
  return { onSelect, props };
}

function openHive() {
  fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
}

describe("HiveNav", () => {
  it("renders the collapsed hive launcher as the app icon", () => {
    renderHive();

    const hive = screen.getByRole("button", { name: /open navigation/i });
    expect(hive.getAttribute("aria-expanded")).toBe("false");
    // The launcher is the brand icon (an <img>), not a text glyph.
    const logo = hive.querySelector("img");
    expect(logo).toBeTruthy();
    expect(logo?.getAttribute("src")).toContain("icon-512.svg");
    // The honeycomb is closed until the hive is clicked.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("blooms the honeycomb of every view (primary + config) when clicked", () => {
    renderHive();

    openHive();

    expect(screen.getByRole("button", { name: /open navigation/i }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(screen.getByRole("menu", { name: "Views" })).toBeTruthy();
    // Primary and config surfaces are all honeycomb menuitems.
    expect(screen.getByRole("menuitem", { name: "Hub" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Updates" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /alerts/i })).toBeTruthy();
  });

  it("selects a view and collapses when a hex is clicked", () => {
    const { onSelect } = renderHive();

    openHive();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(onSelect).toHaveBeenCalledWith("settings");
    // The honeycomb collapses after a selection.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    renderHive();

    openHive();
    expect(screen.getByRole("menu", { name: "Views" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("hides a page toggled off in pagePrefs but keeps a default-visible one", () => {
    // Coaching is a toggleable page switched off; Spend stays on (default visible).
    renderHive({ pagePrefs: { coaching: false } });

    openHive();

    expect(screen.getByRole("menuitem", { name: "Spend" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Coaching" })).toBeNull();
  });

  it("marks the selected hex with the readable-selected class (dark content)", () => {
    renderHive({ view: "settings" });

    openHive();

    const selected = screen.getByRole("menuitem", { name: "Settings" });
    // `is-current` carries the honey-fill + dark-content styling (readable "you are here").
    expect(selected.className).toContain("is-current");
    expect(selected.getAttribute("aria-current")).toBe("page");
    // A non-selected hex does not.
    expect(screen.getByRole("menuitem", { name: "Hub" }).className).not.toContain("is-current");
  });

  it("shows the unread badge on the Alerts hex inside the comb", () => {
    renderHive({ unread: 3 });

    openHive();

    // The Alerts hex carries the count (both as a visible badge and in its accessible name).
    const alerts = screen.getByRole("menuitem", { name: /alerts, 3 unread/i });
    expect(within(alerts.parentElement as HTMLElement).getByText("3")).toBeTruthy();
    // The badge is not on the hive launcher.
    const hive = screen.getByRole("button", { name: /open navigation/i });
    expect(within(hive).queryByText("3")).toBeNull();
  });

  it("offers the bridge-connect control while disconnected", () => {
    renderHive({ connected: false });

    openHive();

    expect(screen.getByLabelText("Bridge URL")).toBeTruthy();
    expect(screen.getByText("Demo (mock)")).toBeTruthy();
  });

  it("shows the Connected chip and no bridge input once connected", () => {
    renderHive({ connected: true });

    openHive();

    expect(screen.queryByLabelText("Bridge URL")).toBeNull();
    expect(screen.getByText("Connected")).toBeTruthy();
  });
});
