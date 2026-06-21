import type { ChatAttachment } from "@honeydrunk/honeyhub-types";

// Chat attachments (HoneyHub attachments v1). The composer reads files (picked, pasted,
// or dropped) into base64 so they ride inline on the StartRunRequest; the bridge writes
// them to a temp dir and references the paths in the task. Shared by both chat surfaces
// (the full Chat screen and the docked sidebar), which render the same RunScreen composer.

/** A file staged in the composer, before it is sent. `data` is base64 with no `data:`
    prefix (the wire shape the bridge decodes). */
export interface PendingAttachment {
  id: string;
  name: string;
  mimeType?: string;
  size: number;
  data: string;
}

/** Largest file we accept inline over the wire (8 MB). Anything bigger is better
    referenced through the workspace than pasted into a chat turn. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Map a few common image MIME types to a file extension, so a pasted image (which the
    browser hands over with an empty name) still gets a sensible, readable filename. */
function extensionForImage(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
}

/** A display name for a file, inventing one for nameless pasted images. */
export function attachmentName(file: { name: string; type: string }): string {
  if (file.name.trim().length > 0) {
    return file.name;
  }
  if (file.type.startsWith("image/")) {
    return `pasted-image.${extensionForImage(file.type)}`;
  }
  return "attachment";
}

/** Read a File into a PendingAttachment (base64, prefix stripped). Rejects if the read
    fails; the caller decides how to surface that. */
export async function readFileAsAttachment(file: File): Promise<PendingAttachment> {
  const data = await readAsBase64(file);
  const mimeType = file.type.length > 0 ? file.type : undefined;
  return {
    id: crypto.randomUUID(),
    name: attachmentName(file),
    ...(mimeType === undefined ? {} : { mimeType }),
    size: file.size,
    data
  };
}

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected file read result"));
        return;
      }
      // readAsDataURL yields `data:<mime>;base64,<payload>`; keep only the payload.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

/** Project staged attachments onto the wire shape (drops the local-only id/size). */
export function toChatAttachments(pending: PendingAttachment[]): ChatAttachment[] {
  return pending.map((item) => ({
    name: item.name,
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    data: item.data
  }));
}

/** Human-readable size for an attachment chip. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
