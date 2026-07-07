// Byte-safe base64 for the integrated terminal (ADR-0103). Raw PTY bytes ride the JSON wire
// as base64 in both directions, so the cockpit needs to decode host output into bytes for
// xterm.js and encode operator keystrokes back. `btoa`/`atob` are latin1-only and corrupt
// multibyte UTF-8, so these go byte-by-byte through the browser-native codecs instead.

/** Encode raw bytes as a base64 string (for `terminal_input`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Decode a base64 string (a `terminal_output` chunk) back to raw bytes. */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode a UTF-8 string as base64 (operator keystrokes, which xterm delivers as strings). */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
