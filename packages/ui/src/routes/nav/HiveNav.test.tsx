import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HiveNav, type HiveNavItem, type HiveNavProps } from "./HiveNav";

const icon = <svg data-testid="icon" />;

// The honeycomb holds only primary views (hub, spend, coaching, work); coaching exercises the
// pagePrefs filter.
const ITEMS: HiveNavItem[] = [
  { view: "hub", label: "Hub", icon },
  { view: "spend", label: "Spend", icon },
  { view: "coaching", label: "Coaching", icon },
  { view: "work", label: "Work", icon }
];

// The config/trust surfaces (Alerts / Updates / Settings) — small icon buttons in the bloom header.
const CONFIG: HiveNavItem[] = [
  { view: "notifications", label: "Alerts", icon },
  { view: "updates", label: "Updates", icon },
  { view: "settings", label: "Settings", icon }
];

function renderHive(overrides: Partial<HiveNavProps> = {}) {
  const onSelect = vi.fn();
  const props: HiveNavProps = {
    items: ITEMS,
    configItems: CONFIG,
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
  it("renders the collapsed hive launcher as the </> mark", () => {
    renderHive();

    const hive = screen.getByRole("button", { name: /open navigation/i });
    expect(hive.getAttribute("aria-expanded")).toBe("false");
    // The launcher is the cyberpunk brand glyph, not an <img>.
    expect(hive.textContent).toContain("</>");
    expect(hive.querySelector("img")).toBeNull();
    // The honeycomb is closed until the hive is clicked.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("blooms a honeycomb of only the primary views", () => {
    renderHive();

    openHive();

    expect(screen.getByRole("button", { name: /open navigation/i }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(screen.getByRole("menu", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Hub" })).toBeTruthy();
    // Config surfaces are NOT honeycomb hexes.
    expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Updates" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /alerts/i })).toBeNull();
  });

  it("renders the config surfaces as header buttons once the hive is open", () => {
    renderHive();

    // Closed: the header (and its config buttons) is not mounted.
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();

    openHive();

    // Open: config surfaces are buttons in the bloom header, not menuitems.
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Updates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /alerts/i })).toBeTruthy();
  });

  it("routes a header config button to its view and closes the bloom", () => {
    const { onSelect } = renderHive();

    openHive();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onSelect).toHaveBeenCalledWith("settings");
    // Clicking a config icon collapses the bloom, same as a hex.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects a view and collapses when a hex is clicked", () => {
    const { onSelect } = renderHive();

    openHive();
    fireEvent.click(screen.getByRole("menuitem", { name: "Spend" }));

    expect(onSelect).toHaveBeenCalledWith("spend");
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
    renderHive({ view: "spend" });

    openHive();

    const selected = screen.getByRole("menuitem", { name: "Spend" });
    // `is-current` carries the honey-fill + dark-content styling (readable "you are here").
    expect(selected.className).toContain("is-current");
    expect(selected.getAttribute("aria-current")).toBe("page");
    // A non-selected hex does not.
    expect(screen.getByRole("menuitem", { name: "Hub" }).className).not.toContain("is-current");
  });

  it("shows the unread badge on the collapsed launcher when the bloom is closed", () => {
    renderHive({ unread: 3 });

    // Closed: the badge is on the launcher (its aria-label also names the count).
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open navigation, 3 unread/i })).toBeTruthy();
    // No header bell exists yet (bloom closed).
    expect(screen.queryByRole("button", { name: /alerts, 3 unread/i })).toBeNull();
  });

  it("moves the unread badge to the header bell when the bloom is open", () => {
    renderHive({ unread: 3 });

    openHive();

    // The bell carries the count as a visible badge and in its accessible name.
    const bell = screen.getByRole("button", { name: /alerts, 3 unread/i });
    expect(within(bell).getByText("3")).toBeTruthy();
    // The launcher no longer shows the badge while open (only the bell's "3" remains).
    expect(screen.getAllByText("3")).toHaveLength(1);
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
