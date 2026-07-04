// The desktop app's own version and shell detection, for the Updates surface (the app
// self-update visibility the operator asked for). `__APP_VERSION__` is replaced at build
// time by Vite (see vite.config.ts) with the package version; when it is absent (a plain
// browser dev server that did not define it) we fall back to "dev".
declare const __APP_VERSION__: string | undefined;

/** The running app version (from package.json at build time), or "dev" when undefined. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/**
 * True when running inside the Tauri desktop shell, which bundles the auto-updater
 * (it checks GitHub releases on launch and installs with the user's OK). False in a plain
 * browser PWA, where updates arrive by reloading. Tauri v2 exposes `window.isTauri`.
 */
export function isTauriShell(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    ("isTauri" in globalThis || "__TAURI_INTERNALS__" in globalThis)
  );
}
