// Byte-safe base64 for wire payloads that carry raw bytes (ADR-0104 launch output, and any
// future binary stream). `btoa`/`atob` are latin1-only and corrupt multibyte UTF-8, so these go
// byte-by-byte through the browser-native codecs instead.

/** Encode raw bytes as a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Decode a base64 string back to raw bytes. */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode a UTF-8 string as base64. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Decode a base64 string as UTF-8 text (lossy on invalid sequences, like a terminal render). */
export function base64ToUtf8(encoded: string): string {
  return new TextDecoder().decode(base64ToBytes(encoded));
}
