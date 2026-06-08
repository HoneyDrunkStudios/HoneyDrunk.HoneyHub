import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the HoneyHub cockpit shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Agent Cockpit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Start a session" })).toBeTruthy();
  });

  it("switches to the bridge settings view", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Bridge settings" }));

    expect(screen.getByRole("heading", { name: "Bridge settings" })).toBeTruthy();
    expect(screen.getByLabelText("Device name")).toBeTruthy();
  });

  it("switches to the spend view", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Spend" }));

    expect(await screen.findByRole("heading", { name: "Your spend" })).toBeTruthy();
  });

  it("switches to the coaching view", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Coaching" }));

    expect(await screen.findByRole("heading", { name: "Coaching" })).toBeTruthy();
  });

  it("switches to the agents view", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });
});
