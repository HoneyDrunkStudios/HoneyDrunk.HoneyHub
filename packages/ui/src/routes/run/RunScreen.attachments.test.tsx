import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StartRunRequest } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import type { StartedRun } from "../../wire/client";
import { RunScreen } from "./RunScreen";

// A mock that records the StartRunRequest it receives, so we can assert attachments rode
// onto the wire. Everything else behaves like the offline mock.
class CapturingClient extends MockWireClient {
  public lastStart: StartRunRequest | undefined;
  override async start(request: StartRunRequest): Promise<StartedRun> {
    this.lastStart = request;
    return super.start(request);
  }
}

function selectFile(file: File): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("RunScreen attachments", () => {
  it("stages a picked file as a chip and sends it on the wire", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    selectFile(new File(["hello"], "notes.txt", { type: "text/plain" }));

    // The chip appears once the file is read.
    expect(await screen.findByText("notes.txt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "review this" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // The attachment rode onto the StartRunRequest as base64, with no local-only fields.
    expect(client.lastStart?.attachments).toEqual([
      { name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=" }
    ]);
    // The task carried the typed prompt (the attachment paths are injected bridge-side).
    expect(client.lastStart?.task).toBe("review this");
  });

  it("rejects an oversized file with an inline note", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    // 9 MB > the 8 MB cap.
    const big = new File([new Uint8Array(9 * 1024 * 1024)], "huge.bin", {
      type: "application/octet-stream"
    });
    selectFile(big);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("too large");
  });
});
