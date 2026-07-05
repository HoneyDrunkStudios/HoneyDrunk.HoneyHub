import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { COMPOSER_PROMPTS } from "./routes/run/RunScreen";

// Each test starts from a clean first-run state (not yet onboarded), so the
// provider-selection screen shows first; the cockpit helper dismisses it. Reset via
// setItem (not clear) so it works regardless of the jsdom Storage method set.
beforeEach(() => {
  try {
    globalThis.localStorage?.setItem(
      "honeyhub.providerPrefs.v1",
      JSON.stringify({ onboarded: false, enabled: [], enabledModels: {} })
    );
  } catch {
    // Storage unavailable — load falls back to the un-onboarded default anyway.
  }
});

/** Render the app and complete the first-run flow (providers → repo locations →
    subscription plans → connect a phone), landing on the cockpit. The plans step is
    skippable — we enter nothing and just Continue. The mock bridge reports Claude as
    detected. */
function renderCockpit() {
  render(<App />);
  // Step 1: providers → continue.
  fireEvent.click(screen.getByRole("button", { name: /continue|skip for now/i }));
  // Step 2: repo locations → finish (no roots added in tests → "Skip for now").
  fireEvent.click(screen.getByRole("button", { name: /finish|skip for now/i }));
  // Step 3: subscription plans (optional) → continue without entering anything.
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // Step 4: connect a phone (optional) → enter the cockpit.
  fireEvent.click(screen.getByRole("button", { name: "Enter the cockpit" }));
}

/** The nav lives in the floating hive launcher now: click it to bloom the honeycomb, then the
    view hexes (role="menuitem") become clickable. */
function openHive() {
  fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
}

/** Open the hive and click a primary view's hex (role="menuitem"). */
function navigate(view: string | RegExp) {
  openHive();
  fireEvent.click(screen.getByRole("menuitem", { name: view }));
}

/** Open the hive and click a config surface (Alerts / Updates / Settings). These are small icon
    buttons in the bloom header (role="button"), not honeycomb hexes. */
function openConfig(name: string | RegExp) {
  openHive();
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("App", () => {
  it("shows the first-run provider selection before the cockpit", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Which agents do you have?" })
    ).toBeTruthy();
  });

  it("renders the HoneyHub cockpit shell after onboarding", () => {
    renderCockpit();

    // The composer heading is one of the rotating prompts (chosen per mount).
    const headings = screen.getAllByRole("heading");
    expect(headings.some((heading) => COMPOSER_PROMPTS.includes(heading.textContent ?? ""))).toBe(
      true
    );
    // The HoneyHub wordmark now lives in the hive launcher's bloom (the brand moved off the
    // removed sidebar), so it appears once the honeycomb is opened.
    openHive();
    expect(screen.getByRole("heading", { name: "HoneyHub" })).toBeTruthy();
  });

  it("opens Settings as a modal over the current page from the header gear", () => {
    renderCockpit();

    openConfig("Settings");

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    // The page behind stays mounted (the composer is still there under the modal) — Settings no
    // longer blanks the page.
    const headings = screen.getAllByRole("heading");
    expect(headings.some((heading) => COMPOSER_PROMPTS.includes(heading.textContent ?? ""))).toBe(
      true
    );
    // Reach a real control: the bridge concerns are their own sections now.
    fireEvent.click(screen.getByRole("button", { name: "Pairing & devices" }));
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });

  it("shows Alerts as a bell button in the bloom header", () => {
    renderCockpit();

    openHive();
    // Alerts is a header icon button, not a honeycomb hex.
    expect(screen.getByRole("button", { name: /alerts/i })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /alerts/i })).toBeNull();
  });

  it("renders the subscription plans panel in Settings and persists a change", () => {
    renderCockpit();

    openConfig("Settings");
    fireEvent.click(screen.getByRole("button", { name: "Plans & costs" }));

    // The plans editor (wired via `plans` + `onPlansChange`) renders in the Plans & costs section.
    const claudePlan = screen.getByLabelText("Claude Code plan") as HTMLSelectElement;
    expect(claudePlan).toBeTruthy();

    // Picking "Flat-rate subscription" flows through onPlansChange and reveals the
    // monthly-cost input, exercising App's plans-wiring lines.
    fireEvent.change(claudePlan, { target: { value: "flat" } });
    expect(screen.getByLabelText("Claude Code monthly cost (USD)")).toBeTruthy();
  });

  it("walks Back through the onboarding steps and sets a plan value", () => {
    render(<App />);

    // Step 1 providers → repos.
    fireEvent.click(screen.getByRole("button", { name: /continue|skip for now/i }));
    // Step 2 repos → plans.
    fireEvent.click(screen.getByRole("button", { name: /finish|skip for now/i }));

    // Step 3 plans: enter a flat-rate plan + a monthly value (exercises PlansSettings
    // through the onboarding step's onChange path).
    expect(
      screen.getByRole("heading", { name: "How do you pay for your providers?" })
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Claude Code plan"), { target: { value: "flat" } });
    fireEvent.change(screen.getByLabelText("Claude Code monthly cost (USD)"), {
      target: { value: "20" }
    });
    // Continue to step 4, then Back to step 3 (phone Back handler).
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Connect a phone (optional)" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("heading", { name: "How do you pay for your providers?" })
    ).toBeTruthy();
    // The entered monthly value survived the round trip.
    expect((screen.getByLabelText("Claude Code monthly cost (USD)") as HTMLInputElement).value).toBe(
      "20"
    );

    // Back to step 2 (plans Back handler), then Back to step 1 (repos Back handler).
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Where do your repos live?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("heading", { name: "Which agents do you have?" })
    ).toBeTruthy();
  });

  it("switches to the repositories view", () => {
    renderCockpit();

    navigate("Repositories");

    expect(screen.getByRole("heading", { name: "Repositories" })).toBeTruthy();
  });

  it("opens the Settings modal and closes it back to the cockpit", () => {
    renderCockpit();

    openConfig("Settings");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    // The backdrop closes the modal (onClose → back to the Hub).
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("switches to the spend view", async () => {
    renderCockpit();

    navigate("Spend");

    expect(await screen.findByRole("heading", { name: "Your spend" })).toBeTruthy();
  });

  it("switches to the coaching view", async () => {
    renderCockpit();

    navigate("Coaching");

    expect(await screen.findByRole("heading", { name: "Coaching" })).toBeTruthy();
  });

  it("switches to the agents view", async () => {
    renderCockpit();

    navigate("Agents");

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });
});
