import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToUtf8, bytesToBase64, utf8ToBase64 } from "./base64";

describe("wire base64", () => {
  it("round-trips arbitrary bytes including high values", () => {
    const bytes = new Uint8Array([0, 1, 27, 91, 65, 127, 128, 200, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes an empty buffer to an empty string and back", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array([]));
  });

  it("round-trips UTF-8 text across a multibyte boundary", () => {
    const text = "compiling ─ \u{1f680}\r\n";
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });
});
