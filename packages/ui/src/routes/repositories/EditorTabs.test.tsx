import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EditorTabs from "./EditorTabs";

describe("EditorTabs", () => {
  it("renders one tab per open file with the active one selected and the dirty one flagged", () => {
    render(
      <EditorTabs
        tabs={[
          { path: "/repo/src/one.ts", dirty: false },
          { path: "/repo/src/two.cs", dirty: true }
        ]}
        activePath="/repo/src/two.cs"
        onActivate={() => {}}
        onClose={() => {}}
      />
    );

    const one = screen.getByRole("tab", { name: "one.ts" });
    const two = screen.getByRole("tab", { name: "two.cs" });
    expect(one.getAttribute("aria-selected")).toBe("false");
    expect(two.getAttribute("aria-selected")).toBe("true");
    expect(two.closest(".repos-tab")?.className).toContain("is-active");
    expect(two.closest(".repos-tab")?.className).toContain("is-dirty");
    expect(one.closest(".repos-tab")?.className).not.toContain("is-dirty");
  });

  it("activates a tab on click and closes it via the ✕", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={[{ path: "/repo/one.ts", dirty: false }]}
        activePath="/repo/one.ts"
        onActivate={onActivate}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "one.ts" }));
    expect(onActivate).toHaveBeenCalledWith("/repo/one.ts");

    fireEvent.click(screen.getByRole("button", { name: "Close one.ts" }));
    expect(onClose).toHaveBeenCalledWith("/repo/one.ts");
  });

  it("renders nothing when there are no open files", () => {
    const { container } = render(
      <EditorTabs tabs={[]} activePath={undefined} onActivate={() => {}} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });
});
