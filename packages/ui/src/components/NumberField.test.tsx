import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumberField } from "./NumberField";

describe("NumberField", () => {
  it("steps up and down by `step`, honoring the value", () => {
    const onChange = vi.fn();
    render(<NumberField value="5" step={2} onChange={onChange} ariaLabel="count" />);
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith("7");
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(onChange).toHaveBeenLastCalledWith("3");
  });

  it("clamps to min and disables decrease at the floor", () => {
    const onChange = vi.fn();
    render(<NumberField value="1" min={1} onChange={onChange} ariaLabel="count" />);
    const decrease = screen.getByRole("button", { name: "Decrease" });
    expect(decrease).toHaveProperty("disabled", true);
    // Increase from min still works.
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith("2");
  });

  it("steps from min when the value is blank", () => {
    const onChange = vi.fn();
    render(<NumberField value="" min={0} onChange={onChange} ariaLabel="count" />);
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith("1");
  });

  it("passes typed input straight through", () => {
    const onChange = vi.fn();
    render(<NumberField value="" onChange={onChange} ariaLabel="count" />);
    fireEvent.change(screen.getByLabelText("count"), { target: { value: "42" } });
    expect(onChange).toHaveBeenLastCalledWith("42");
  });
});
