import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Monaco can't render in jsdom, so stub @monaco-editor/react's DiffEditor with a plain element
// that surfaces the props DiffViewer feeds it (original/modified/language/theme/readOnly).
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: {
    original: string;
    modified: string;
    language: string;
    theme: string;
    options?: { readOnly?: boolean; renderSideBySide?: boolean };
  }) => (
    <div
      data-testid="monaco-diff"
      data-language={props.language}
      data-theme={props.theme}
      data-readonly={String(props.options?.readOnly)}
      data-side-by-side={String(props.options?.renderSideBySide)}
    >
      <pre data-testid="monaco-original">{props.original}</pre>
      <pre data-testid="monaco-modified">{props.modified}</pre>
    </div>
  )
}));

// DiffViewer reuses CodeEditor's theme/worker setup, whose module scope drives the real Monaco
// loader (unusable in jsdom). Stub the three reused exports so the test stays hermetic; the
// languageForPath stub keeps the .tsx -> typescript mapping the component relies on.
vi.mock("./CodeEditor", () => ({
  configureMonaco: () => undefined,
  MONO_FONT: "mono",
  languageForPath: (path: string) =>
    path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : "plaintext"
}));

import DiffViewer from "./DiffViewer";

describe("DiffViewer", () => {
  it("feeds both versions into a read-only side-by-side honeypunk DiffEditor", () => {
    render(
      <DiffViewer
        path="src/app.tsx"
        original={'const view = "run";\n'}
        modified={'const view = "chat";\n'}
      />
    );

    const editor = screen.getByTestId("monaco-diff");
    expect(editor.getAttribute("data-language")).toBe("typescript");
    expect(editor.getAttribute("data-theme")).toBe("honeypunk");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(editor.getAttribute("data-side-by-side")).toBe("true");
    expect(screen.getByTestId("monaco-original").textContent).toBe('const view = "run";\n');
    expect(screen.getByTestId("monaco-modified").textContent).toBe('const view = "chat";\n');
  });

  it("renders a new file as an all-added diff (empty original)", () => {
    render(<DiffViewer path="src/new.ts" original="" modified={"added\n"} />);

    expect(screen.getByTestId("monaco-original").textContent).toBe("");
    expect(screen.getByTestId("monaco-modified").textContent).toBe("added\n");
  });
});
