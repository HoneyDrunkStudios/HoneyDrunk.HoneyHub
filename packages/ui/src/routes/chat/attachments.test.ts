import { describe, expect, it } from "vitest";
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

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
