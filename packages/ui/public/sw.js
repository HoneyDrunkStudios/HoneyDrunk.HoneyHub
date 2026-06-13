const CACHE_NAME = "honeyhub-shell-v1";
const SCOPE_URL = new URL(globalThis.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname;
const scopedUrl = (path) => new URL(path, globalThis.registration.scope).toString();
const APP_SHELL = [
  scopedUrl("./"),
  scopedUrl("manifest.webmanifest"),
  scopedUrl("icons/icon-192.png"),
  scopedUrl("icons/icon-512.png"),
  scopedUrl("icons/icon-192.svg"),
  scopedUrl("icons/icon-512.svg")
];
const CACHEABLE_DESTINATIONS = new Set(["script", "style", "worker", "font"]);

globalThis.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  globalThis.skipWaiting();
});

globalThis.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => globalThis.clients.claim())
  );
});

globalThis.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.origin !== globalThis.location.origin || !url.pathname.startsWith(SCOPE_PATH)) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(scopedUrl("./"))));
    return;
  }

  const scopedPath = url.pathname.slice(SCOPE_PATH.length);

  if (
    CACHEABLE_DESTINATIONS.has(event.request.destination) ||
    scopedPath.startsWith("assets/") ||
    scopedPath.startsWith("src/")
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
          }

          return response;
        });

        return cached || network;
      })
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((response) => response || fetch(event.request)));
});
