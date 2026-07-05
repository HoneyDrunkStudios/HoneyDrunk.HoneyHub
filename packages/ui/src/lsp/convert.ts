// Conversions between the LSP protocol (0-based positions, its own enums) and Monaco (1-based
// positions, its own enums). Pure functions parameterised by the injected Monaco namespace, so
// they carry no runtime dependency on monaco-editor and are unit-testable with a fake Monaco.

import type * as Monaco from "monaco-editor";
import type {
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit
} from "vscode-languageserver-protocol";

export type MonacoNamespace = typeof Monaco;

/** Monaco (1-based line/column) position -> LSP (0-based line/character). */
export function toLspPosition(position: { lineNumber: number; column: number }): Position {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP range -> a Monaco range (1-based, end-exclusive columns map directly). */
export function toMonacoRange(monaco: MonacoNamespace, range: Range): Monaco.IRange {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  );
}

// LSP CompletionItemKind (stable numeric) -> its name, so we can map onto Monaco's own enum by
// name (the two enums share these names but use different numeric values).
const LSP_COMPLETION_KIND_NAME: Record<number, string> = {
  1: "Text",
  2: "Method",
  3: "Function",
  4: "Constructor",
  5: "Field",
  6: "Variable",
  7: "Class",
  8: "Interface",
  9: "Module",
  10: "Property",
  11: "Unit",
  12: "Value",
  13: "Enum",
  14: "Keyword",
  15: "Snippet",
  16: "Color",
  17: "File",
  18: "Reference",
  19: "Folder",
  20: "EnumMember",
  21: "Constant",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "TypeParameter"
};

function monacoCompletionKind(monaco: MonacoNamespace, lspKind: number | undefined): number {
  const kinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
  const name = lspKind === undefined ? undefined : LSP_COMPLETION_KIND_NAME[lspKind];
  if (name !== undefined && kinds[name] !== undefined) {
    return kinds[name];
  }
  return kinds.Text ?? 0;
}

/** LSP MarkupContent | MarkedString | (…)[]  ->  Monaco IMarkdownString[] (for hovers/docs). */
export function toMarkdownStrings(
  contents: MarkupContent | MarkedString | Array<MarkupContent | MarkedString> | string | undefined
): Monaco.IMarkdownString[] {
  if (contents === undefined || contents === null) {
    return [];
  }
  if (Array.isArray(contents)) {
    return contents.flatMap((entry) => toMarkdownStrings(entry));
  }
  if (typeof contents === "string") {
    return contents.length > 0 ? [{ value: contents }] : [];
  }
  // MarkupContent { kind, value } — kind is "markdown" | "plaintext"; both render as markdown.
  if ("kind" in contents && typeof contents.value === "string") {
    return contents.value.length > 0 ? [{ value: contents.value }] : [];
  }
  // MarkedString { language, value } — fence it so Monaco highlights the snippet.
  if ("language" in contents && typeof contents.value === "string") {
    return [{ value: "```" + contents.language + "\n" + contents.value + "\n```" }];
  }
  return [];
}

/** LSP completion result -> a Monaco CompletionList. `defaultRange` is the word range at the
    cursor, used when an item carries no explicit edit range. */
export function toMonacoCompletionList(
  monaco: MonacoNamespace,
  result: CompletionItem[] | CompletionList | null | undefined,
  defaultRange: Monaco.IRange
): Monaco.languages.CompletionList {
  if (result === null || result === undefined) {
    return { suggestions: [] };
  }
  const items = Array.isArray(result) ? result : result.items;
  const incomplete = Array.isArray(result) ? false : result.isIncomplete === true;
  const snippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const suggestions = items.map((item) => toMonacoCompletionItem(monaco, item, defaultRange, snippetRule));
  return { suggestions, incomplete };
}

function toMonacoCompletionItem(
  monaco: MonacoNamespace,
  item: CompletionItem,
  defaultRange: Monaco.IRange,
  snippetRule: number
): Monaco.languages.CompletionItem {
  // Prefer an explicit text edit's range/text; fall back to insertText, then the label.
  let range: Monaco.IRange = defaultRange;
  let insertText = item.insertText ?? item.label;
  const edit = item.textEdit as TextEdit | { newText: string; insert: Range; replace: Range } | undefined;
  if (edit !== undefined) {
    insertText = edit.newText;
    if ("range" in edit) {
      range = toMonacoRange(monaco, edit.range);
    } else if ("insert" in edit) {
      range = toMonacoRange(monaco, edit.insert);
    }
  }
  const isSnippet = item.insertTextFormat === 2;
  const documentation = toDocumentation(item.documentation);
  const suggestion: Monaco.languages.CompletionItem = {
    label: item.label,
    kind: monacoCompletionKind(monaco, item.kind),
    insertText,
    range
  };
  if (isSnippet) {
    suggestion.insertTextRules = snippetRule;
  }
  if (item.detail !== undefined) {
    suggestion.detail = item.detail;
  }
  if (documentation !== undefined) {
    suggestion.documentation = documentation;
  }
  if (item.sortText !== undefined) {
    suggestion.sortText = item.sortText;
  }
  if (item.filterText !== undefined) {
    suggestion.filterText = item.filterText;
  }
  return suggestion;
}

function toDocumentation(
  documentation: string | MarkupContent | undefined
): Monaco.IMarkdownString | string | undefined {
  if (documentation === undefined) {
    return undefined;
  }
  if (typeof documentation === "string") {
    return documentation;
  }
  return { value: documentation.value };
}

/** LSP Hover -> Monaco Hover (contents + optional range). */
export function toMonacoHover(
  monaco: MonacoNamespace,
  hover: Hover | null | undefined
): Monaco.languages.Hover | null {
  if (hover === null || hover === undefined) {
    return null;
  }
  const contents = toMarkdownStrings(hover.contents);
  if (contents.length === 0) {
    return null;
  }
  const result: Monaco.languages.Hover = { contents };
  if (hover.range !== undefined) {
    result.range = toMonacoRange(monaco, hover.range);
  }
  return result;
}

/** LSP definition/references result (Location | Location[] | LocationLink[]) -> Monaco
    locations. Cross-file targets are returned as-is; Monaco peeks whichever have a model. */
export function toMonacoLocations(
  monaco: MonacoNamespace,
  result: Location | Location[] | LocationLink[] | null | undefined
): Monaco.languages.Location[] {
  if (result === null || result === undefined) {
    return [];
  }
  const array = Array.isArray(result) ? result : [result];
  return array.map((entry) => {
    if ("targetUri" in entry) {
      // LocationLink
      return {
        uri: monaco.Uri.parse(entry.targetUri),
        range: toMonacoRange(monaco, entry.targetSelectionRange)
      };
    }
    return { uri: monaco.Uri.parse(entry.uri), range: toMonacoRange(monaco, entry.range) };
  });
}

/** LSP WorkspaceEdit -> a Monaco WorkspaceEdit (text edits per resource). Handles the
    `changes` map form; the `documentChanges` form is flattened to its text edits. */
export function toMonacoWorkspaceEdit(
  monaco: MonacoNamespace,
  edit: WorkspaceEdit | null | undefined
): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
  if (edit === null || edit === undefined) {
    return { edits };
  }
  const push = (uri: string, textEdits: TextEdit[]): void => {
    for (const textEdit of textEdits) {
      edits.push({
        resource: monaco.Uri.parse(uri),
        versionId: undefined,
        textEdit: { range: toMonacoRange(monaco, textEdit.range), text: textEdit.newText }
      });
    }
  };
  if (edit.changes !== undefined) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      push(uri, textEdits);
    }
  }
  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        push(change.textDocument.uri, change.edits as TextEdit[]);
      }
    }
  }
  return { edits };
}

/** LSP diagnostics -> Monaco marker data (mapping severities onto MarkerSeverity). */
export function toMonacoMarkers(
  monaco: MonacoNamespace,
  diagnostics: Diagnostic[]
): Monaco.editor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const range = toMonacoRange(monaco, diagnostic.range);
    const marker: Monaco.editor.IMarkerData = {
      severity: markerSeverity(monaco, diagnostic.severity),
      // LSP 3.18 allows a MarkupContent message; Monaco markers are plain strings.
      message: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value,
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn
    };
    if (diagnostic.code !== undefined) {
      marker.code = String(diagnostic.code);
    }
    if (diagnostic.source !== undefined) {
      marker.source = diagnostic.source;
    }
    return marker;
  });
}

function markerSeverity(monaco: MonacoNamespace, severity: number | undefined): number {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}
