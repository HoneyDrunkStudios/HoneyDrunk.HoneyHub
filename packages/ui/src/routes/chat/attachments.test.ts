import { describe, expect, it, vi } from "vitest";
import {
  attachmentName,
  formatBytes,
  readFileAsAttachment,
  toChatAttachments,
  type PendingAttachment
} from "./attachments";

describe("attachments", () => {
  it("reads a file into a base64 PendingAttachment", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const attachment = await readFileAsAttachment(file);
    expect(attachment.name).toBe("notes.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.size).toBe(5);
    // "hello" -> base64
    expect(attachment.data).toBe("aGVsbG8=");
    expect(attachment.id.length).toBeGreaterThan(0);
  });

  it("invents a name for a nameless pasted image", () => {
    expect(attachmentName({ name: "", type: "image/png" })).toBe("pasted-image.png");
    expect(attachmentName({ name: "", type: "image/jpeg" })).toBe("pasted-image.jpg");
    expect(attachmentName({ name: "diagram.svg", type: "image/svg+xml" })).toBe("diagram.svg");
    expect(attachmentName({ name: "", type: "application/octet-stream" })).toBe("attachment");
  });

  it("maps each known image type to its extension, defaulting to png", () => {
    // Every branch of extensionForImage (exercised through attachmentName for nameless files).
    expect(attachmentName({ name: "", type: "image/gif" })).toBe("pasted-image.gif");
    expect(attachmentName({ name: "", type: "image/webp" })).toBe("pasted-image.webp");
    expect(attachmentName({ name: "", type: "image/svg+xml" })).toBe("pasted-image.svg");
    // An unrecognized image subtype still gets a name, defaulting to .png.
    expect(attachmentName({ name: "", type: "image/heic" })).toBe("pasted-image.png");
  });

  it("treats a whitespace-only name as nameless", () => {
    expect(attachmentName({ name: "   ", type: "image/png" })).toBe("pasted-image.png");
  });

  it("omits the mimeType for a typeless file", async () => {
    // A File with no type leaves mimeType absent (exactOptionalPropertyTypes path).
    const file = new File(["x"], "blob.bin", { type: "" });
    const attachment = await readFileAsAttachment(file);
    expect("mimeType" in attachment).toBe(false);
    expect(attachment.name).toBe("blob.bin");
    expect(attachment.data).toBe("eA==");
  });

  it("projects pending attachments onto the wire shape", () => {
    const pending: PendingAttachment[] = [
      { id: "1", name: "a.txt", mimeType: "text/plain", size: 1, data: "AA==" },
      { id: "2", name: "b.bin", size: 2, data: "AAA=" }
    ];
    const wire = toChatAttachments(pending);
    expect(wire).toEqual([
      { name: "a.txt", mimeType: "text/plain", data: "AA==" },
      { name: "b.bin", data: "AAA=" }
    ]);
    // No local-only fields leak onto the wire.
    expect(Object.keys(wire[1] ?? {})).not.toContain("mimeType");
    expect(Object.keys(wire[0] ?? {})).not.toContain("id");
  });

  it("formats sizes across each unit boundary", () => {
    expect(formatBytes(512)).toBe("512 B");
    // Under 10 KB keeps one decimal; at/over 10 KB drops to a whole number.
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    // Exactly 1024 crosses into KB; just under stays in bytes.
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("rejects when the reader yields a non-string result", async () => {
    const RealFileReader = globalThis.FileReader;
    class ArrayReader {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public error: unknown = null;
      public result: unknown = new ArrayBuffer(2);
      readAsDataURL(): void {
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", ArrayReader);
    try {
      await expect(readFileAsAttachment(new File(["x"], "a.bin"))).rejects.toThrow(
        "unexpected file read result"
      );
    } finally {
      vi.stubGlobal("FileReader", RealFileReader);
    }
  });

  it("keeps the whole result when the data URL has no comma", async () => {
    const RealFileReader = globalThis.FileReader;
    class NoCommaReader {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public error: unknown = null;
      // A degenerate result with no comma: the payload is kept verbatim.
      public result: string = "rawpayloadnocomma";
      readAsDataURL(): void {
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", NoCommaReader);
    try {
      const attachment = await readFileAsAttachment(new File(["x"], "a.bin"));
      expect(attachment.data).toBe("rawpayloadnocomma");
    } finally {
      vi.stubGlobal("FileReader", RealFileReader);
    }
  });

  it("rejects with the reader's error on a failed read", async () => {
    const RealFileReader = globalThis.FileReader;
    class ErrorReader {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public error: unknown = new Error("disk gone");
      public result: string | null = null;
      readAsDataURL(): void {
        this.onerror?.();
      }
    }
    vi.stubGlobal("FileReader", ErrorReader);
    try {
      await expect(readFileAsAttachment(new File(["x"], "a.bin"))).rejects.toThrow("disk gone");
    } finally {
      vi.stubGlobal("FileReader", RealFileReader);
    }
  });
});
