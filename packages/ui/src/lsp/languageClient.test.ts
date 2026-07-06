import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent, BridgeEventPayload, LspStatus } from "@honeydrunk/honeyhub-types";
import type { WireClient, WireEventHandler } from "../wire/client";
import type { MonacoNamespace } from "./convert";
import {
  __resetLanguageClientsForTest,
  attachLanguageClient,
  isLspLanguage
} from "./languageClient";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type SentMessage = { root: string; languageId: string; message: Record<string, unknown> };

/** A WireClient double that records LSP traffic and can push bridge events back. */
class MockWire {
  handlers = new Set<WireEventHandler>();
  starts: Array<[string, string]> = [];
  stops: Array<[string, string]> = [];
  sends: SentMessage[] = [];

  subscribe(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async lspStart(root: string, languageId: string): Promise<void> {
    this.starts.push([root, languageId]);
  }
  async lspSend(root: string, languageId: string, message: unknown): Promise<void> {
    this.sends.push({ root, languageId, message: message as Record<string, unknown> });
  }
  async lspStop(root: string, languageId: string): Promise<void> {
    this.stops.push([root, languageId]);
  }

  emit(payload: BridgeEventPayload): void {
    const event: BridgeEvent = {
      id: "e",
      sessionId: "",
      runId: "",
      sequence: 0,
      createdAt: "t",
      payload
    };
    for (const handler of [...this.handlers]) {
      handler(event);
    }
  }

  /** Find the first request we sent for a given LSP method (to read its id). */
  requestFor(method: string): Record<string, unknown> | undefined {
    return this.sends.map((entry) => entry.message).find((message) => message.method === method);
  }

  asClient(): WireClient {
    return this as unknown as WireClient;
  }
}

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

interface CompletionProvider {
  provideCompletionItems: (model: unknown, position: unknown) => unknown;
}
interface CapturedProviders {
  completion?: CompletionProvider;
}

function fakeMonaco(providers: CapturedProviders): MonacoNamespace {
  return {
    Range: FakeRange as unknown,
    Uri: {
      file: (path: string) => ({ toString: () => `file://${path}` }),
      parse: (value: string) => ({ toString: () => value })
    },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages: {
      CompletionItemKind: { Text: 18, Function: 1 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_lang: string, provider: CompletionProvider) => {
        providers.completion = provider;
        return { dispose: () => undefined };
      },
      registerHoverProvider: () => ({ dispose: () => undefined }),
      registerDefinitionProvider: () => ({ dispose: () => undefined }),
      registerReferenceProvider: () => ({ dispose: () => undefined }),
      registerRenameProvider: () => ({ dispose: () => undefined })
    },
    editor: { setModelMarkers: vi.fn() }
  } as unknown as MonacoNamespace;
}

function fakeModel(uri: string, text: string): import("monaco-editor").editor.ITextModel {
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    onDidChangeContent: () => ({ dispose: () => undefined }),
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4, word: "", startLineNumber: 1 })
  } as unknown as import("monaco-editor").editor.ITextModel;
}

const ROOT = "C:/work/repo";
const LANG = "typescript";

function statusPayload(overrides: Partial<LspStatus>): BridgeEventPayload {
  return {
    kind: "lsp_status",
    status: {
      root: ROOT,
      languageId: LANG,
      serverId: "typescript-language-server",
      installed: true,
      running: true,
      reason: "language server running",
      ...overrides
    }
  };
}

describe("attachLanguageClient", () => {
  beforeEach(() => {
    __resetLanguageClientsForTest();
  });

  it("knows which languages have an allowlisted server", () => {
    expect(isLspLanguage("typescript")).toBe(true);
    expect(isLspLanguage("rust")).toBe(true);
    expect(isLspLanguage("markdown")).toBe(false);
    expect(isLspLanguage("plaintext")).toBe(false);
  });

  it("degrades honestly and starts no LSP traffic when no server is installed", async () => {
    const wire = new MockWire();
    const providers: CapturedProviders = {};
    const statuses: Array<LspStatus | undefined> = [];
    const dispose = attachLanguageClient({
      monaco: fakeMonaco(providers),
      model: fakeModel("inmemory://model/1", "const x = 1;"),
      filePath: `${ROOT}/src/a.ts`,
      root: ROOT,
      languageId: LANG,
      client: wire.asClient(),
      onStatus: (status) => statuses.push(status)
    });

    // The bridge reports no installed server -> graceful degradation.
    wire.emit(statusPayload({ installed: false, running: false, reason: "language server not installed" }));
    await flush();

    expect(wire.starts).toEqual([[ROOT, LANG]]);
    // Nothing initialized: no initialize request ever left the client.
    expect(wire.requestFor("initialize")).toBeUndefined();
    expect(statuses.some((status) => status?.installed === false && status.reason.includes("not installed"))).toBe(
      true
    );
    dispose();
  });

  it("initializes against a running server and serves a completion round-trip", async () => {
    const wire = new MockWire();
    const providers: CapturedProviders = {};
    const model = fakeModel("inmemory://model/2", "cons");
    const dispose = attachLanguageClient({
      monaco: fakeMonaco(providers),
      model,
      filePath: `${ROOT}/src/b.ts`,
      root: ROOT,
      languageId: LANG,
      client: wire.asClient()
    });

    // Server comes up -> the client sends `initialize` synchronously.
    wire.emit(statusPayload({}));
    const initialize = wire.requestFor("initialize");
    expect(initialize).toBeDefined();

    // Answer initialize; the client then sends `initialized` + `didOpen` and registers providers.
    wire.emit({
      kind: "lsp_message",
      root: ROOT,
      languageId: LANG,
      message: { jsonrpc: "2.0", id: initialize?.id, result: { capabilities: {} } }
    });
    await flush();
    await flush();

    expect(wire.sends.some((entry) => entry.message.method === "initialized")).toBe(true);
    expect(wire.sends.some((entry) => entry.message.method === "textDocument/didOpen")).toBe(true);
    expect(providers.completion).toBeDefined();

    // Drive the completion provider end to end: it sends a request, we answer, it converts.
    const pending = providers.completion?.provideCompletionItems(model, { lineNumber: 1, column: 5 }) as Promise<
      import("monaco-editor").languages.CompletionList
    >;
    await flush();
    const completion = wire.requestFor("textDocument/completion");
    expect(completion).toBeDefined();
    wire.emit({
      kind: "lsp_message",
      root: ROOT,
      languageId: LANG,
      message: {
        jsonrpc: "2.0",
        id: completion?.id,
        result: [{ label: "console", kind: 3 }]
      }
    });
    const list = await pending;
    expect(list.suggestions[0]?.label).toBe("console");
    expect(list.suggestions[0]?.insertText).toBe("console");

    // Disposing the last file for this server stops it.
    dispose();
    expect(wire.stops).toEqual([[ROOT, LANG]]);
  });
});
