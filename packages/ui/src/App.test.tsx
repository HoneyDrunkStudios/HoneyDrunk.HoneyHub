import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

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

/** Render the app and complete the first-run flow (providers → repo locations → connect a
    phone), landing on the cockpit. The mock bridge reports Claude as detected. */
function renderCockpit() {
  render(<App />);
  // Step 1: providers → continue.
  fireEvent.click(screen.getByRole("button", { name: /continue|skip for now/i }));
  // Step 2: repo locations → finish (no roots added in tests → "Skip for now").
  fireEvent.click(screen.getByRole("button", { name: /finish|skip for now/i }));
  // Step 3: connect a phone (optional) → enter the cockpit.
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
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
  });

  it("switches to the settings view", () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });

  it("switches to the browse view", () => {
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    expect(screen.getByRole("heading", { name: "Your repos" })).toBeTruthy();
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
