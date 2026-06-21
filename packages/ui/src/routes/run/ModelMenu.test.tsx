import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelMenu, type ModelOption } from "./ModelMenu";

const OPTIONS: ModelOption[] = [
  { backend: "claude.local", id: "opus", label: "Claude Opus 4.8" },
  { backend: "claude.local", id: "sonnet", label: "Claude Sonnet 4.6" },
  { backend: "codex.local", id: "gpt-5.5", label: "GPT-5.5" }
];

function renderMenu(overrides: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ModelMenu
      options={OPTIONS}
      selectedBackend="claude.local"
      selectedId="opus"
      customId="__custom__"
      suggestedBackend="codex.local"
      onSelect={onSelect}
      {...overrides}
    />
  );
  return { onSelect };
}

describe("ModelMenu", () => {
  it("shows the selected model label on the trigger", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Opus 4.8");
  });

  it("shows 'Custom model' on the trigger when the custom sentinel is selected", () => {
    renderMenu({ selectedId: "__custom__" });
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Custom model");
  });

  it("opens the listbox and lists every option plus a custom entry", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const listbox = screen.getByRole("listbox", { name: "Select model" });
    const labels = within(listbox)
      .getAllByRole("option")
      .map((option) => option.querySelector(".model-option-label")?.textContent);
    expect(labels).toEqual(["Claude Opus 4.8", "Claude Sonnet 4.6", "GPT-5.5", "Custom model…"]);
  });

  it("tags the suggested backend's options and marks the active option selected", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const listbox = screen.getByRole("listbox", { name: "Select model" });
    // The active (selected) option is aria-selected.
    expect(within(listbox).getByRole("option", { name: /Claude Opus 4\.8/ }).getAttribute("aria-selected")).toBe("true");
    // The suggested backend (codex) tags its option.
    expect(within(listbox).getByRole("option", { name: /GPT-5\.5/ }).textContent).toContain("suggested");
  });

  it("selects a concrete model (routing to its backend) and closes", () => {
    const { onSelect } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const listbox = screen.getByRole("listbox", { name: "Select model" });
    fireEvent.click(within(listbox).getByRole("option", { name: /GPT-5\.5/ }));
    expect(onSelect).toHaveBeenCalledWith("codex.local", "gpt-5.5");
    expect(screen.queryByRole("listbox", { name: "Select model" })).toBeNull();
  });

  it("selects the custom entry, keeping the current backend", () => {
    const { onSelect } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const listbox = screen.getByRole("listbox", { name: "Select model" });
    fireEvent.click(within(listbox).getByRole("option", { name: /Custom model/ }));
    expect(onSelect).toHaveBeenCalledWith("claude.local", "__custom__");
  });

  it("closes the menu via the backdrop", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("listbox", { name: "Select model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close model picker" }));
    expect(screen.queryByRole("listbox", { name: "Select model" })).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Select model" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Select model" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("roves focus across options with the arrow keys", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const listbox = screen.getByRole("listbox", { name: "Select model" });
    // Opening focuses the active option; ArrowDown/ArrowUp move between options.
    const opus = within(listbox).getByRole("option", { name: /Claude Opus 4\.8/ });
    expect(document.activeElement).toBe(opus);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      within(listbox).getByRole("option", { name: /Claude Sonnet 4\.6/ })
    );
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(document.activeElement).toBe(opus);
  });
});
