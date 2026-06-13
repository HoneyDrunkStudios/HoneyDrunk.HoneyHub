import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./registerServiceWorker";

describe("registerServiceWorker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing outside production", () => {
    vi.stubEnv("PROD", false);
    const addEventListener = vi.fn();
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn() } });

    registerServiceWorker();

    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("registers sw.js on the load event when in production with SW support", () => {
    vi.stubEnv("PROD", true);
    vi.stubEnv("BASE_URL", "/");
    const register = vi.fn().mockResolvedValue(undefined);
    let loadHandler: (() => void) | undefined;
    vi.stubGlobal("addEventListener", (type: string, handler: () => void) => {
      if (type === "load") loadHandler = handler;
    });
    vi.stubGlobal("navigator", { serviceWorker: { register } });
    vi.stubGlobal("location", { origin: "https://cockpit.example" });

    registerServiceWorker();
    expect(loadHandler).toBeDefined();

    // Firing the load event performs the actual registration.
    loadHandler?.();
    expect(register).toHaveBeenCalledTimes(1);
    const registered = register.mock.calls[0]?.[0] as URL;
    expect(registered.href).toBe("https://cockpit.example/sw.js");
  });
});
