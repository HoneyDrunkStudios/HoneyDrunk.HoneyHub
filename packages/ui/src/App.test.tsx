import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the HoneyHub cockpit shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Agent Cockpit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No active session" })).toBeTruthy();
  });
});
