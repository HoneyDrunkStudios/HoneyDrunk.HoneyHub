import { describe, expect, it } from "vitest";
import { buildConnectUrl, isLoopbackHost, qrMatrix, tokenFromSearch } from "./mobilePairing";

describe("connectPhone helpers", () => {
  it("recognizes loopback hosts (and only those)", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(true);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
    expect(isLoopbackHost("100.110.0.1")).toBe(false);
  });

  it("builds a token-bearing URL, omitting empty port/token", () => {
    expect(
      buildConnectUrl({ ip: "100.110.0.1", port: "8765", token: "abc", protocol: "http:" })
    ).toBe("http://100.110.0.1:8765/?token=abc");
    // No port → no colon; no token → no query; default protocol.
    expect(buildConnectUrl({ ip: "10.0.0.5", port: "", token: "" })).toBe("http://10.0.0.5/");
    // Token is URL-encoded.
    expect(
      buildConnectUrl({ ip: "10.0.0.5", port: "80", token: "a b/c", protocol: "http:" })
    ).toBe("http://10.0.0.5:80/?token=a%20b%2Fc");
  });

  it("reads the token from a URL query", () => {
    expect(tokenFromSearch("?token=xyz")).toBe("xyz");
    expect(tokenFromSearch("?foo=1&token=xyz&bar=2")).toBe("xyz");
    expect(tokenFromSearch("")).toBe("");
  });

  it("encodes a QR matrix with a square module count and a non-empty path", () => {
    const matrix = qrMatrix("http://100.110.0.1:8765/?token=abc");
    // A short URL fits in a small version; module count is square and odd-ish but > 0.
    expect(matrix.count).toBeGreaterThan(0);
    expect(matrix.path.length).toBeGreaterThan(0);
    // Path is made of unit-square move/line commands.
    expect(matrix.path.startsWith("M")).toBe(true);
  });

  it("returns an empty matrix for empty input (no throw)", () => {
    expect(qrMatrix("")).toEqual({ count: 0, path: "" });
  });
});
