import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Single source of truth for the app version (the Updates surface shows it): read from
// package.json at config load and inline it into `__APP_VERSION__` at build time.
const appVersion: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      provider: "v8",
      // lcov for SonarQube Cloud import; text for the CI log.
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"]
    }
  }
});
