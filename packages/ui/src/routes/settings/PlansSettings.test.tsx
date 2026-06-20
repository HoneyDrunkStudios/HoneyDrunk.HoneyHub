import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlansSettings } from "./PlansSettings";
import type { Plans } from "../../plans";

describe("PlansSettings", () => {
  it("renders a plan select per configurable backend and the why tooltip", () => {
    render(<PlansSettings plans={{}} onChange={() => undefined} />);
    // The info affordance carries the explanation in its title.
    const tip = screen.getByRole("button", { name: "Why we ask" });
    expect(tip.getAttribute("title")).toMatch(/effectively free/i);
    // A row for each configurable backend (Claude, Codex).
    expect(screen.getByLabelText("Claude Code plan")).toBeTruthy();
    expect(screen.getByLabelText("Codex plan")).toBeTruthy();
  });

  it("emits a flat plan and reveals the monthly input when flat-rate is chosen", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PlansSettings plans={{}} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Claude Code plan"), {
      target: { value: "flat" }
    });
    expect(onChange).toHaveBeenCalledWith({ "claude.local": { type: "flat" } });

    // Re-render with the persisted flat plan; the monthly input should now appear.
    const flat: Plans = { "claude.local": { type: "flat" } };
    rerender(<PlansSettings plans={flat} onChange={onChange} />);
    const monthly = screen.getByLabelText("Claude Code monthly cost (USD)");
    fireEvent.change(monthly, { target: { value: "20" } });
    expect(onChange).toHaveBeenLastCalledWith({
      "claude.local": { type: "flat", monthlyUsd: 20 }
    });
  });

  it("clears the plan back to unset", () => {
    const onChange = vi.fn();
    const flat: Plans = { "codex.local": { type: "flat", monthlyUsd: 10 } };
    render(<PlansSettings plans={flat} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Codex plan"), { target: { value: "unset" } });
    // Setting unset with no amount drops the entry entirely.
    expect(onChange).toHaveBeenCalledWith({});
  });
});
