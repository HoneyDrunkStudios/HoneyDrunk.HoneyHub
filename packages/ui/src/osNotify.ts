// Thin wrapper over the Web Notifications API (works in the browser PWA and the Tauri shell,
// which proxies it to the OS). All calls are guarded so a browser without the API, or without
// granted permission, simply no-ops — the in-app feed is always the fallback.

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function notificationPermission(): NotifyPermission {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

/** Ask the OS for permission (no-op when unsupported/already-decided beyond default). */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  if (Notification.permission !== "default") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Show an OS toast if permission is granted. Clicking it focuses the app and opens `link`. */
export function osNotify(title: string, body: string, link?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      try {
        globalThis.focus?.();
        if (link !== undefined && link.length > 0) {
          globalThis.open(link, "_blank", "noopener");
        }
      } finally {
        notification.close();
      }
    };
  } catch {
    // Some environments throw on construction (e.g. no service worker); ignore.
  }
}
