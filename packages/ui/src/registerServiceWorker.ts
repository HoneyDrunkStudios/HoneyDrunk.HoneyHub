export function registerServiceWorker() {
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    globalThis.addEventListener("load", () => {
      const serviceWorkerUrl = new URL("sw.js", new URL(import.meta.env.BASE_URL, globalThis.location.origin));

      navigator.serviceWorker.register(serviceWorkerUrl).catch(() => {
        // PWA installability should not block local development.
      });
    });
  }
}
