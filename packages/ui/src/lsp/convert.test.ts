import { describe, expect, it } from "vitest";
import type { MonacoNamespace } from "./convert";
import {
  toLspPosition,
  toMonacoCompletionList,
  toMonacoHover,
  toMonacoLocations,
  toMonacoMarkers,
  toMonacoWorkspaceEdit
} from "./convert";

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

/** A fake Monaco namespace exposing just the constructors/enums the converters touch. */
function fakeMonaco(): MonacoNamespace {
  return {
    Range: FakeRange as unknown,
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages: {
      CompletionItemKind: { Text: 18, Function: 1, Variable: 4, Class: 6 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 }
    }
  } as unknown as MonacoNamespace;
}

describe("position + range conversion", () => {
  it("maps Monaco 1-based positions to LSP 0-based", () => {
    expect(toLspPosition({ lineNumber: 3, column: 5 })).toEqual({ line: 2, character: 4 });
  });
});

describe("toMonacoCompletionList", () => {
  it("maps items, kinds, snippet rule, and a text-edit range", () => {
    const monaco = fakeMonaco();
    const defaultRange = new FakeRange(1, 1, 1, 1) as unknown as import("monaco-editor").IRange;
    const list = toMonacoCompletionList(
      monaco,
      [
        { label: "plain", kind: 3 },
        {
          label: "snip",
          kind: 3,
          insertTextFormat: 2,
          textEdit: {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
            newText: "snip($1)"
          }
        }
      ],
      defaultRange
    );
    expect(list.suggestions).toHaveLength(2);
    const [plain, snip] = list.suggestions;
    // No edit -> falls back to the label as insert text and the default range.
    expect(plain?.insertText).toBe("plain");
    expect(plain?.kind).toBe(monaco.languages.CompletionItemKind.Function);
    expect(plain?.range).toBe(defaultRange);
    // Snippet -> the text edit's newText + range, and the snippet insert rule.
    expect(snip?.insertText).toBe("snip($1)");
    expect(snip?.insertTextRules).toBe(monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
    expect((snip?.range as FakeRange).startColumn).toBe(3);
  });

  it("returns an empty list for a null result", () => {
    expect(toMonacoCompletionList(fakeMonaco(), null, new FakeRange(1, 1, 1, 1) as never).suggestions).toEqual([]);
  });
});

describe("toMonacoHover", () => {
  it("renders MarkupContent contents and a range", () => {
    const hover = toMonacoHover(fakeMonaco(), {
      contents: { kind: "markdown", value: "**doc**" },
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
    });
    expect(hover?.contents[0]?.value).toBe("**doc**");
    expect((hover?.range as FakeRange).startLineNumber).toBe(2);
  });

  it("returns null when there are no contents", () => {
    expect(toMonacoHover(fakeMonaco(), null)).toBeNull();
    expect(toMonacoHover(fakeMonaco(), { contents: [] })).toBeNull();
  });
});

describe("toMonacoLocations", () => {
  it("converts a single Location and a LocationLink array", () => {
    const monaco = fakeMonaco();
    const single = toMonacoLocations(monaco, {
      uri: "file:///a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
    });
    expect(single).toHaveLength(1);
    expect(single[0]?.uri.toString()).toBe("file:///a.ts");

    const links = toMonacoLocations(monaco, [
      {
        targetUri: "file:///b.ts",
        targetRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
        targetSelectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }
      }
    ]);
    expect(links[0]?.uri.toString()).toBe("file:///b.ts");
  });
});

describe("toMonacoWorkspaceEdit", () => {
  it("flattens the changes map into resource text edits", () => {
    const edit = toMonacoWorkspaceEdit(fakeMonaco(), {
      changes: {
        "file:///a.ts": [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "Bar" }
        ]
      }
    });
    expect(edit.edits).toHaveLength(1);
    const first = edit.edits[0] as import("monaco-editor").languages.IWorkspaceTextEdit;
    expect(first.resource.toString()).toBe("file:///a.ts");
    expect(first.textEdit.text).toBe("Bar");
  });
});

describe("toMonacoMarkers", () => {
  it("maps severities and a MarkupContent message", () => {
    const monaco = fakeMonaco();
    const markers = toMonacoMarkers(monaco, [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
        severity: 1,
        message: "an error",
        code: "TS1005",
        source: "ts"
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 2,
        message: { kind: "markdown", value: "a warning" }
      }
    ]);
    expect(markers[0]?.severity).toBe(monaco.MarkerSeverity.Error);
    expect(markers[0]?.message).toBe("an error");
    expect(markers[0]?.code).toBe("TS1005");
    expect(markers[1]?.severity).toBe(monaco.MarkerSeverity.Warning);
    expect(markers[1]?.message).toBe("a warning");
    expect(markers[1]?.startLineNumber).toBe(2);
  });
});
