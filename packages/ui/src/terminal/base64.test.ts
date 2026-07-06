import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, utf8ToBase64 } from "./base64";

describe("terminal base64", () => {
  it("round-trips arbitrary bytes including high values", () => {
    const bytes = new Uint8Array([0, 1, 27, 91, 65, 127, 128, 200, 255]);
    const encoded = bytesToBase64(bytes);
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  it("encodes an empty buffer to an empty string and back", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array([]));
  });

  it("encodes UTF-8 text so it decodes back losslessly across a multibyte boundary", () => {
    // A box-drawing char + an emoji: multibyte UTF-8 that a latin1 btoa would corrupt.
    const text = "ls ─ 🐝\r\n";
    const decoded = new TextDecoder().decode(base64ToBytes(utf8ToBase64(text)));
    expect(decoded).toBe(text);
  });
});
