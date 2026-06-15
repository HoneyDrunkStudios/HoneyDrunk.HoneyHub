import qrcode from "qrcode-generator";

// "Connect a phone" (mobile pairing) helpers. The cockpit already knows its own port + token
// (from window.location), so a phone-reachable URL only needs a reachable host address (the
// bridge reports those via `list_network`). HONESTY: a QR is just the handoff — the phone can
// only connect if the host is actually bound to a reachable interface. The component checks
// whether the cockpit is being viewed over loopback and guides the user accordingly. Pure
// helpers, kept out of the component so they're unit-testable.

/** Hosts that are NOT reachable from another device (the cockpit is bound to this machine). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

/** Build the URL a phone should open: `<protocol>//<ip>:<port>/?token=<token>`. The token
    is what authenticates the WebSocket, so it must ride along. Omits an empty port (default
    80/443) and an empty token (caller decides whether that's usable). */
export function buildConnectUrl(options: {
  ip: string;
  port: string;
  token: string;
  protocol?: string;
}): string {
  const protocol = options.protocol && options.protocol.length > 0 ? options.protocol : "http:";
  const host = options.port && options.port.length > 0 ? `${options.ip}:${options.port}` : options.ip;
  const query = options.token && options.token.length > 0 ? `?token=${encodeURIComponent(options.token)}` : "";
  return `${protocol}//${host}/${query}`;
}

/** Read the pairing token from the cockpit's own URL query (`?token=...`). */
export function tokenFromSearch(search: string): string {
  return new URLSearchParams(search).get("token") ?? "";
}

export interface QrMatrix {
  /** The module count per side (the QR is `count × count` cells). */
  count: number;
  /** An SVG path `d` covering every dark module as a 1×1 square (use with `fill`). */
  path: string;
}

/** Encode `text` into a QR matrix and return its module count + an SVG path string. Uses
    error-correction level M (a good balance for a short URL). Returns an empty matrix for
    empty input so the caller can show a placeholder instead of throwing. */
export function qrMatrix(text: string): QrMatrix {
  if (text.length === 0) {
    return { count: 0, path: "" };
  }
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        path += `M${col} ${row}h1v1h-1z`;
      }
    }
  }
  return { count, path };
}
