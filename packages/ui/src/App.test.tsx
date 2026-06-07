import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the HoneyHub cockpit shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Agent Cockpit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No active session" })).toBeTruthy();
  });

  it("switches to the bridge settings view", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bridge settings" }));

    expect(screen.getByRole("heading", { name: "Bridge settings" })).toBeTruthy();
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });
});
