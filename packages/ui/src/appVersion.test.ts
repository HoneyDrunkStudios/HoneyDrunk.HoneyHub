import { describe, expect, it } from "vitest";
import { APP_VERSION, isTauriShell } from "./appVersion";

describe("appVersion", () => {
  it("exposes a non-empty version string", () => {
    expect(typeof APP_VERSION).toBe("string");
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });

  it("reports a plain browser (no Tauri shell) in the test environment", () => {
    // jsdom has no `isTauri` / `__TAURI_INTERNALS__`, so this is the browser-PWA path.
    expect(isTauriShell()).toBe(false);
  });

  it("detects the Tauri shell when the global marker is present", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.isTauri = true;
    try {
      expect(isTauriShell()).toBe(true);
    } finally {
      delete globals.isTauri;
    }
  });
});
