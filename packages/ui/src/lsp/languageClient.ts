// Wires the bridge's LSP proxy (ADR-0102) to the standalone Monaco editor: starts an
// allowlisted language server, runs the LSP handshake, keeps the open document in sync, and
// lights up completion / hover / go-to-definition / find-all-references / rename / diagnostics.
// When no server is running (none allowlisted, none installed, or it exited) it does nothing
// extra — the file keeps today's in-file Monaco IntelliSense — and reports an honest status.
//
// One shared client per (root, languageId) is reused across files (matching the bridge's one
// server per language/root). Monaco providers are registered once per language and look up the
// live client by the model's URI, so opening several files of the same language just works.

import type * as Monaco from "monaco-editor";
import type { BridgeEvent, LspStatus } from "@honeydrunk/honeyhub-types";
import {
  CompletionRequest,
  ConfigurationRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest
} from "vscode-languageserver-protocol";
import type {
  CompletionItem,
  CompletionList,
  Hover,
  InitializeParams,
  Location,
  LocationLink,
  PublishDiagnosticsParams,
  WorkspaceEdit
} from "vscode-languageserver-protocol";
import type { WireClient } from "../wire/client";
import { createBridgeLspConnection, type BridgeLspConnection, type LspTransport } from "./connection";
import {
  toLspPosition,
  toMonacoCompletionList,
  toMonacoHover,
  toMonacoLocations,
  toMonacoMarkers,
  toMonacoWorkspaceEdit,
  type MonacoNamespace
} from "./convert";

/** The Monaco language ids the bridge has an allowlisted server for (mirrors the bridge's LSP
    table). The editor only starts a server for these — everything else keeps in-file
    IntelliSense with no needless round-trip. Adding a language is a one-line change here + a
    row in the bridge's allowlist (no new plumbing). */
export const LSP_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "rust",
  "csharp"
]);

export function isLspLanguage(languageId: string): boolean {
  return LSP_LANGUAGES.has(languageId);
}

/** The marker owner for LSP diagnostics, kept distinct from Monaco's built-in owners (e.g.
    "typescript") so the two coexist and we only ever clear our own squiggles. */
const LSP_MARKER_OWNER = "honeyhub-lsp";

interface OpenDoc {
  model: Monaco.editor.ITextModel;
  /** The file:// URI sent to the server (may differ from the Monaco model URI). */
  fileUri: string;
  version: number;
  changeSub: Monaco.IDisposable;
  /** Set when a `didChange` was refused (backpressure/dead socket) and the server's copy
      is now stale; a pending resync re-sends the full document until it lands, so the
      server model can never permanently desync from the buffer. */
  resyncTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface SharedClient {
  root: string;
  languageId: string;
  connection: BridgeLspConnection | undefined;
  /** Resolves true once initialized against a running server, false when degraded. */
  ready: Promise<boolean>;
  status: LspStatus;
  docs: Map<string, OpenDoc>;
  refs: number;
  disposeStatus: () => void;
  statusListeners: Set<(status: LspStatus | undefined) => void>;
  disposed: boolean;
}

// Module registries. `clients` is keyed by (root \0 languageId); `docIndex` maps a model URI to
// its owning client so a globally-registered provider can find the right connection; and
// `providerLanguages` guards one-time provider registration per language.
const clients = new Map<string, SharedClient>();
const docIndex = new Map<string, SharedClient>();
const providerLanguages = new Set<string>();

function keyOf(root: string, languageId: string): string {
  return `${root}\u0000${languageId}`;
}

function fileUri(monaco: MonacoNamespace, path: string): string {
  return monaco.Uri.file(path).toString();
}

/** The client capabilities we advertise — the six features this integration lights up. */
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    completion: {
      dynamicRegistration: false,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"]
      }
    },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: false },
    publishDiagnostics: { relatedInformation: true }
  },
  workspace: { configuration: true, workspaceFolders: true }
} as const;

/** Adapt a WireClient into the connection's transport: send via `lsp_send`, receive the
    matching `lsp_message` events. */
function wireLspTransport(client: WireClient, root: string, languageId: string): LspTransport {
  return {
    send(message) {
      // Propagate failure: the connection fails a pending request fast when the bridge
      // refuses a frame (URI/method denial, backpressure, no running server) instead of
      // leaving it hanging on a response that will never come.
      return client.lspSend(root, languageId, message);
    },
    onMessage(handler) {
      return client.subscribe((event: BridgeEvent) => {
        const payload = event.payload;
        if (
          payload.kind === "lsp_message" &&
          payload.root === root &&
          payload.languageId === languageId
        ) {
          handler(payload.message);
        }
      });
    }
  };
}

function notifyStatus(shared: SharedClient): void {
  for (const listener of shared.statusListeners) {
    listener(shared.status);
  }
}

async function startConnection(
  monaco: MonacoNamespace,
  client: WireClient,
  shared: SharedClient
): Promise<void> {
  const connection = createBridgeLspConnection(wireLspTransport(client, shared.root, shared.languageId));
  shared.connection = connection;

  // Answer the server->client requests we can't fully satisfy, so the server never stalls.
  connection.onRequest(ConfigurationRequest.method, (params) => {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
    return items.map(() => null);
  });
  connection.onRequest(RegistrationRequest.method, () => null);
  connection.onRequest(UnregistrationRequest.method, () => null);
  connection.onRequest(WorkDoneProgressCreateRequest.method, () => null);
  connection.onNotification(PublishDiagnosticsNotification.method, (params) => {
    applyDiagnostics(monaco, shared, params as PublishDiagnosticsParams);
  });

  const rootUri = fileUri(monaco, shared.root);
  const initParams: InitializeParams = {
    processId: null,
    rootUri,
    capabilities: CLIENT_CAPABILITIES as unknown as InitializeParams["capabilities"],
    workspaceFolders: [{ uri: rootUri, name: shared.root }]
  };
  await connection.sendRequest(InitializeRequest.method, initParams);
  connection.sendNotification(InitializedNotification.method, {});
}

function applyDiagnostics(
  monaco: MonacoNamespace,
  shared: SharedClient,
  params: PublishDiagnosticsParams
): void {
  for (const doc of shared.docs.values()) {
    if (doc.fileUri === params.uri) {
      monaco.editor.setModelMarkers(doc.model, LSP_MARKER_OWNER, toMonacoMarkers(monaco, params.diagnostics));
      return;
    }
  }
}

function openDocument(
  monaco: MonacoNamespace,
  shared: SharedClient,
  model: Monaco.editor.ITextModel,
  filePath: string
): void {
  const modelUri = model.uri.toString();
  if (shared.docs.has(modelUri) || shared.connection === undefined) {
    return;
  }
  const uri = fileUri(monaco, filePath);
  const connection = shared.connection;
  connection.sendNotification(DidOpenTextDocumentNotification.method, {
    textDocument: { uri, languageId: shared.languageId, version: 1, text: model.getValue() }
  });
  const changeSub = model.onDidChangeContent(() => {
    const doc = shared.docs.get(modelUri);
    if (doc === undefined) {
      return;
    }
    doc.version += 1;
    sendDidChange(shared, doc);
  });
  shared.docs.set(modelUri, { model, fileUri: uri, version: 1, changeSub });
  docIndex.set(modelUri, shared);
}

/** Full-document sync (the server re-parses the whole file). If the notification is
    refused (backpressure/dead socket), the server's copy is now stale, so schedule a
    resync that re-sends the latest full document until it lands. Because every sync is a
    full-document replace, a later resend naturally carries the newest content, so the
    server model can never permanently desync from the buffer. */
function sendDidChange(shared: SharedClient, doc: OpenDoc): void {
  const connection = shared.connection;
  if (connection === undefined) {
    return;
  }
  void connection
    .sendNotificationTracked(DidChangeTextDocumentNotification.method, {
      textDocument: { uri: doc.fileUri, version: doc.version },
      contentChanges: [{ text: doc.model.getValue() }]
    })
    .then(() => {
      if (doc.resyncTimer !== undefined) {
        clearTimeout(doc.resyncTimer);
        doc.resyncTimer = undefined;
      }
    })
    .catch(() => scheduleResync(shared, doc));
}

const DIDCHANGE_RESYNC_DELAY_MS = 500;

function scheduleResync(shared: SharedClient, doc: OpenDoc): void {
  if (doc.resyncTimer !== undefined || shared.connection === undefined) {
    return; // a resync is already pending, or the connection is gone
  }
  doc.resyncTimer = setTimeout(() => {
    doc.resyncTimer = undefined;
    // Re-send only if the doc is still open on a live connection; bump the version so the
    // resend supersedes the dropped change, and carry the latest full content.
    if (shared.connection === undefined || !shared.docs.has(doc.model.uri.toString())) {
      return;
    }
    doc.version += 1;
    sendDidChange(shared, doc);
  }, DIDCHANGE_RESYNC_DELAY_MS);
}

function closeDocument(monaco: MonacoNamespace, shared: SharedClient, modelUri: string): void {
  const doc = shared.docs.get(modelUri);
  if (doc === undefined) {
    return;
  }
  if (doc.resyncTimer !== undefined) {
    clearTimeout(doc.resyncTimer);
    doc.resyncTimer = undefined;
  }
  doc.changeSub.dispose();
  shared.connection?.sendNotification(DidCloseTextDocumentNotification.method, {
    textDocument: { uri: doc.fileUri }
  });
  monaco.editor.setModelMarkers(doc.model, LSP_MARKER_OWNER, []);
  shared.docs.delete(modelUri);
  docIndex.delete(modelUri);
}

function degrade(monaco: MonacoNamespace, shared: SharedClient): void {
  for (const doc of shared.docs.values()) {
    if (doc.resyncTimer !== undefined) {
      clearTimeout(doc.resyncTimer);
      doc.resyncTimer = undefined;
    }
    monaco.editor.setModelMarkers(doc.model, LSP_MARKER_OWNER, []);
  }
  shared.connection?.dispose();
  shared.connection = undefined;
}

function teardownSharedClient(
  monaco: MonacoNamespace,
  client: WireClient,
  key: string,
  shared: SharedClient
): void {
  if (shared.disposed) {
    return;
  }
  shared.disposed = true;
  clients.delete(key);
  for (const modelUri of [...shared.docs.keys()]) {
    closeDocument(monaco, shared, modelUri);
  }
  shared.disposeStatus();
  shared.connection?.dispose();
  shared.connection = undefined;
  void client.lspStop(shared.root, shared.languageId).catch(() => undefined);
}

function createSharedClient(
  monaco: MonacoNamespace,
  client: WireClient,
  root: string,
  languageId: string
): SharedClient {
  let resolveReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const shared: SharedClient = {
    root,
    languageId,
    connection: undefined,
    ready,
    status: {
      root,
      languageId,
      serverId: "",
      installed: false,
      running: false,
      reason: "starting language server…"
    },
    docs: new Map(),
    refs: 0,
    disposeStatus: () => undefined,
    statusListeners: new Set(),
    disposed: false
  };

  let settled = false;
  shared.disposeStatus = client.subscribe((event: BridgeEvent) => {
    const payload = event.payload;
    if (payload.kind !== "lsp_status") {
      return;
    }
    const status = payload.status;
    if (status.root !== root || status.languageId !== languageId) {
      return;
    }
    shared.status = status;
    if (!settled) {
      settled = true;
      if (status.running && status.installed) {
        startConnection(monaco, client, shared).then(
          () => resolveReady(true),
          () => resolveReady(false)
        );
      } else {
        resolveReady(false);
      }
    } else if (!status.running && shared.connection !== undefined) {
      // The server exited after being up — degrade to in-file IntelliSense.
      degrade(monaco, shared);
    }
    notifyStatus(shared);
  });

  void client.lspStart(root, languageId).catch(() => {
    if (!settled) {
      settled = true;
      shared.status = { ...shared.status, reason: "could not start language server" };
      resolveReady(false);
      notifyStatus(shared);
    }
  });

  return shared;
}

/** Register the six LSP-backed Monaco providers for `languageId`, once. Each provider looks up
    the live client by the model's URI and forwards to the server; with no client (or no
    connection) it returns nothing, so Monaco's in-file IntelliSense is what the user sees. */
function registerProviders(monaco: MonacoNamespace, languageId: string): void {
  if (providerLanguages.has(languageId)) {
    return;
  }
  providerLanguages.add(languageId);
  const languages = monaco.languages;

  const docFor = (model: Monaco.editor.ITextModel): { shared: SharedClient; doc: OpenDoc } | undefined => {
    const uri = model.uri.toString();
    const shared = docIndex.get(uri);
    const doc = shared?.docs.get(uri);
    if (shared === undefined || shared.connection === undefined || doc === undefined) {
      return undefined;
    }
    return { shared, doc };
  };

  languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: [".", ":", "<", '"', "'", "/", "@", " ", "("],
    provideCompletionItems: async (model, position) => {
      const found = docFor(model);
      if (found === undefined) {
        return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const defaultRange = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn
      );
      try {
        const result = await found.shared.connection!.sendRequest<CompletionItem[] | CompletionList | null>(
          CompletionRequest.method,
          { textDocument: { uri: found.doc.fileUri }, position: toLspPosition(position) }
        );
        return toMonacoCompletionList(monaco, result, defaultRange);
      } catch {
        return { suggestions: [] };
      }
    }
  });

  languages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      const found = docFor(model);
      if (found === undefined) {
        return null;
      }
      try {
        const result = await found.shared.connection!.sendRequest<Hover | null>(HoverRequest.method, {
          textDocument: { uri: found.doc.fileUri },
          position: toLspPosition(position)
        });
        return toMonacoHover(monaco, result);
      } catch {
        return null;
      }
    }
  });

  languages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model, position) => {
      const found = docFor(model);
      if (found === undefined) {
        return [];
      }
      try {
        const result = await found.shared.connection!.sendRequest<Location | Location[] | LocationLink[] | null>(
          DefinitionRequest.method,
          { textDocument: { uri: found.doc.fileUri }, position: toLspPosition(position) }
        );
        return toMonacoLocations(monaco, result);
      } catch {
        return [];
      }
    }
  });

  languages.registerReferenceProvider(languageId, {
    provideReferences: async (model, position, context) => {
      const found = docFor(model);
      if (found === undefined) {
        return [];
      }
      try {
        const result = await found.shared.connection!.sendRequest<Location[] | null>(ReferencesRequest.method, {
          textDocument: { uri: found.doc.fileUri },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration }
        });
        return toMonacoLocations(monaco, result);
      } catch {
        return [];
      }
    }
  });

  languages.registerRenameProvider(languageId, {
    provideRenameEdits: async (model, position, newName) => {
      const found = docFor(model);
      if (found === undefined) {
        return { edits: [] };
      }
      try {
        const result = await found.shared.connection!.sendRequest<WorkspaceEdit | null>(RenameRequest.method, {
          textDocument: { uri: found.doc.fileUri },
          position: toLspPosition(position),
          newName
        });
        const { edit, unsupportedOperations } = toMonacoWorkspaceEdit(monaco, result);
        if (unsupportedOperations) {
          // The rename spans file create/rename/delete operations this in-editor path
          // cannot apply atomically; refuse it whole (never a partial buffer edit) and
          // surface Monaco's native rejection so the operator can drive it through an
          // agent/PR flow instead.
          return {
            edits: [],
            rejectReason:
              "This rename also creates, renames, or deletes files. HoneyHub's editor applies " +
              "text edits only, so nothing was changed. Use an agent or a PR for cross-file renames."
          };
        }
        return edit;
      } catch {
        return { edits: [] };
      }
    }
  });
}

/** Options for {@link attachLanguageClient}. */
export interface AttachOptions {
  monaco: MonacoNamespace;
  model: Monaco.editor.ITextModel;
  /** The file's absolute path (drives the file:// URI sent to the server). */
  filePath: string;
  /** The allowlisted workspace/repo root the server is scoped to. */
  root: string;
  languageId: string;
  client: WireClient;
  /** Receives the honest capability status (for a quiet "no server" note). */
  onStatus?: (status: LspStatus | undefined) => void;
}

/**
 * Attach `model` to a (shared) language server for its (root, languageId). Starts the server on
 * first use, registers providers, opens the document, and keeps it synced. Returns a disposer
 * that closes the document and, when the last file for that server closes, stops the server.
 *
 * Safe to call for any language: a language with no allowlisted/installed server resolves to a
 * degraded status (reported via `onStatus`) and no LSP features — the file keeps its in-file
 * IntelliSense. Never throws.
 */
export function attachLanguageClient(options: AttachOptions): () => void {
  const { monaco, model, filePath, root, languageId, client, onStatus } = options;
  const key = keyOf(root, languageId);

  let shared = clients.get(key);
  if (shared === undefined) {
    shared = createSharedClient(monaco, client, root, languageId);
    clients.set(key, shared);
  }
  const sharedClient = shared;
  sharedClient.refs += 1;

  let released = false;
  const modelUri = model.uri.toString();
  const listener = (status: LspStatus | undefined): void => onStatus?.(status);
  if (onStatus !== undefined) {
    sharedClient.statusListeners.add(listener);
    // Reflect the current (likely "starting…") status immediately.
    onStatus(sharedClient.status);
  }

  void sharedClient.ready.then(
    (ok) => {
      if (released) {
        return;
      }
      onStatus?.(sharedClient.status);
      if (ok && sharedClient.connection !== undefined) {
        registerProviders(monaco, languageId);
        openDocument(monaco, sharedClient, model, filePath);
      }
    },
    () => {
      if (!released) {
        onStatus?.(sharedClient.status);
      }
    }
  );

  return () => {
    if (released) {
      return;
    }
    released = true;
    sharedClient.statusListeners.delete(listener);
    closeDocument(monaco, sharedClient, modelUri);
    sharedClient.refs -= 1;
    if (sharedClient.refs <= 0) {
      teardownSharedClient(monaco, client, key, sharedClient);
    }
  };
}

/** Test-only: clear all module state between tests (no server processes are involved here). */
export function __resetLanguageClientsForTest(): void {
  clients.clear();
  docIndex.clear();
  providerLanguages.clear();
}
