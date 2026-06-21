import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartRunRequest } from "@honeydrunk/honeyhub-types";
import { MockWireClient } from "../../wire/mockClient";
import type { StartedRun } from "../../wire/client";
import { RunScreen } from "./RunScreen";

// jsdom's localStorage is read-only here (setItem throws), and RunScreen persists the active
// chat to it as the run progresses. Stub a fresh in-memory Storage per test so those writes
// do not blow up the render and stay isolated between cases.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

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

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("stages a pasted image (nameless) with an invented name", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    // A clipboard paste of a screenshot: the browser hands over a nameless image File.
    const pasted = new File([new Uint8Array([1, 2, 3])], "", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("Task"), {
      clipboardData: { files: [pasted] }
    });

    // attachments.ts invents a readable name for a nameless image.
    expect(await screen.findByText("pasted-image.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // An attachment-only turn still launches with the neutral prompt and the image on the wire.
    expect(client.lastStart?.task).toBe("Take a look at the attached file(s).");
    expect(client.lastStart?.attachments?.[0]?.name).toBe("pasted-image.png");
    expect(client.lastStart?.attachments?.[0]?.mimeType).toBe("image/png");
  });

  it("stages files dropped onto the composer", async () => {
    const client = new CapturingClient();
    const { container } = render(
      <RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />
    );

    const composer = container.querySelector(".composer") as HTMLElement;
    fireEvent.drop(composer, {
      dataTransfer: { files: [new File(["dropped"], "dropped.txt", { type: "text/plain" })] }
    });

    expect(await screen.findByText("dropped.txt")).toBeTruthy();
  });

  it("removes a staged attachment chip and drops it from the wire payload", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    selectFile(new File(["a"], "keep.txt", { type: "text/plain" }));
    selectFile(new File(["bb"], "drop.txt", { type: "text/plain" }));

    expect(await screen.findByText("keep.txt")).toBeTruthy();
    expect(await screen.findByText("drop.txt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove drop.txt" }));

    await waitFor(() => expect(screen.queryByText("drop.txt")).toBeNull());
    expect(screen.getByText("keep.txt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // Only the surviving attachment rides onto the wire.
    expect(client.lastStart?.attachments).toEqual([
      { name: "keep.txt", mimeType: "text/plain", data: "YQ==" }
    ]);
  });

  it("blocks an empty start (no task, no attachment) with an inline error", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Enter a task or attach a file");
    expect(client.lastStart).toBeUndefined();
  });

  it("clears the staged chips after a successful start", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    selectFile(new File(["x"], "gone.txt", { type: "text/plain" }));
    expect(await screen.findByText("gone.txt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // The composer's staged tray is emptied once the run launches (the chip no longer shows).
    await waitFor(() => expect(screen.queryByText("gone.txt")).toBeNull());
  });

  it("carries attachments on a follow-up after the run completes", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    // Start a run, then drive it to completion via the scripted mock reply.
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // The mock parks the run at needs_input; reply to push it to completed.
    const reply = await screen.findByLabelText("Reply");
    fireEvent.change(reply, { target: { value: "the file" } });
    fireEvent.keyDown(reply, { key: "Enter" });

    // Once completed the box flips to "Follow up" and the attach button reappears.
    const followUp = await screen.findByLabelText("Follow up");

    // Attach a file for the follow-up turn, then send it.
    selectFile(new File(["next"], "more.txt", { type: "text/plain" }));
    expect(await screen.findByText("more.txt")).toBeTruthy();

    fireEvent.change(followUp, { target: { value: "look again" } });
    fireEvent.keyDown(followUp, { key: "Enter" });

    // The follow-up is a NEW run that carries the prior transcript + the new attachment.
    await waitFor(() => {
      expect(client.lastStart?.task).toBe("look again");
      expect(client.lastStart?.followUpToRunId).toBeDefined();
      expect(client.lastStart?.transcript?.length).toBeGreaterThan(0);
      expect(client.lastStart?.attachments).toEqual([
        { name: "more.txt", mimeType: "text/plain", data: "bmV4dA==" }
      ]);
    });
  });

  it("surfaces a read failure as an inline note", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    // A File whose body cannot be read: stub the reader path by handing a blob whose
    // arrayBuffer/stream throw. readFileAsAttachment uses FileReader.readAsDataURL, so
    // force its error by making the File's size pass the cap but the read reject.
    const bad = new File(["data"], "bad.txt", { type: "text/plain" });
    Object.defineProperty(bad, "stream", {
      value: () => {
        throw new Error("no stream");
      }
    });
    // FileReader in jsdom reads the blob's internal bytes; to force onerror, replace the
    // global FileReader with one that always errors for this single case.
    const RealFileReader = globalThis.FileReader;
    class ErroringReader {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public error: unknown = new Error("read failed");
      public result: string | null = null;
      readAsDataURL(): void {
        this.onerror?.();
      }
    }
    vi.stubGlobal("FileReader", ErroringReader);
    try {
      selectFile(bad);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not read that file.");
    } finally {
      vi.stubGlobal("FileReader", RealFileReader);
    }
  });

  it("ignores an empty file selection (no chip, no error)", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // An empty FileList (the user cancelled the OS picker) stages nothing.
    fireEvent.change(input, { target: { files: [] } });

    expect(screen.queryByLabelText("Attachments")).toBeNull();
  });

  it("ignores a paste with no files", () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    // A plain-text paste (no clipboard files) must not stage anything.
    fireEvent.paste(screen.getByLabelText("Task"), { clipboardData: { files: [] } });
    expect(screen.queryByLabelText("Attachments")).toBeNull();
  });

  it("appends an attachment note to the displayed user turn", async () => {
    const client = new CapturingClient();
    render(<RunScreen client={client} availableBackends={["claude.local"]} workspaceRoots={["/repo"]} />);

    selectFile(new File(["a"], "shot.txt", { type: "text/plain" }));
    expect(await screen.findByText("shot.txt")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "look" } });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    // The transcript honestly names what was attached.
    const transcript = await screen.findByLabelText("Transcript");
    await waitFor(() =>
      expect(within(transcript).getByText(/\[Attached: shot\.txt\]/)).toBeTruthy()
    );
  });
});
