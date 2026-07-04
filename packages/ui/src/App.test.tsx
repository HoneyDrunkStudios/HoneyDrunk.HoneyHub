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

describe("App", () => {
  it("shows the first-run provider selection before the cockpit", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Which agents do you have?" })
    ).toBeTruthy();
  });

  it("renders the HoneyHub cockpit shell after onboarding", () => {
    renderCockpit();

    expect(screen.getByRole("heading", { name: "HoneyHub" })).toBeTruthy();
    // The composer heading is one of the rotating prompts (chosen per mount).
    const headings = screen.getAllByRole("heading");
    expect(headings.some((heading) => COMPOSER_PROMPTS.includes(heading.textContent ?? ""))).toBe(
      true
    );
  });

  it("switches to the settings view", () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });

  it("renders the subscription plans panel in Settings and persists a change", () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    // The plans editor (wired via `plans` + `onPlansChange`) renders in Settings.
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

    fireEvent.click(screen.getByRole("button", { name: "Repositories" }));

    expect(screen.getByRole("heading", { name: "Repositories" })).toBeTruthy();
  });

  it("opens the Settings modal and closes it back to the cockpit", () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    // The backdrop closes the modal (onClose → back to the Hub).
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("switches to the spend view", async () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Spend" }));

    expect(await screen.findByRole("heading", { name: "Your spend" })).toBeTruthy();
  });

  it("switches to the coaching view", async () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Coaching" }));

    expect(await screen.findByRole("heading", { name: "Coaching" })).toBeTruthy();
  });

  it("switches to the agents view", async () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });
});
