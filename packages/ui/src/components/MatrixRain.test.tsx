import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MatrixRain } from "./MatrixRain";

describe("MatrixRain", () => {
  it("mounts and unmounts without throwing (jsdom has no 2d canvas context)", () => {
    // In jsdom canvas.getContext returns null, so the effect bails after appending +
    // removing its canvas. The component renders null into the React tree either way.
    const { container, unmount } = render(<MatrixRain />);
    expect(container.firstChild).toBeNull();
    unmount();
    // No orphaned backdrop canvas is left on the document body after unmount.
    expect(document.querySelector(".matrix-rain")).toBeNull();
  });
});
