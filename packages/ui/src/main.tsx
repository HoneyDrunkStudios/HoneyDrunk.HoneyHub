import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./registerServiceWorker";
import { applyTheme, loadTheme } from "./theme";

// Apply the saved theme before the first paint so there's no flash of the default.
applyTheme(loadTheme());

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("HoneyHub root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

registerServiceWorker();
