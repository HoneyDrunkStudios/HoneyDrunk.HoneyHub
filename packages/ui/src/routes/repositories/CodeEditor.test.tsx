import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Monaco and its Vite `?worker` imports can't load in jsdom, so stub them all. We only exercise
// the pure language-mapping helper and that the component mounts without reaching for a CDN; the
// real editor is verified by the vite build + manual dogfooding.
vi.mock("monaco-editor", () => ({}));
vi.mock("@monaco-editor/react", () => ({ default: () => null, loader: { config: vi.fn() } }));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: class {} }));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({ default: class {} }));

import CodeEditor, { configureLanguageDefaults, languageForPath } from "./CodeEditor";

/** A minimal fake of Monaco's `languages.typescript` namespace with spies on the two language
    defaults, so we can assert `configureLanguageDefaults` wires the compiler + diagnostics. */
function makeDefaults() {
  return {
    getCompilerOptions: vi.fn(() => ({})),
    setCompilerOptions: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn()
  };
}

function makeMonaco() {
  return {
    languages: {
      typescript: {
        typescriptDefaults: makeDefaults(),
        javascriptDefaults: makeDefaults(),
        ScriptTarget: { ESNext: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        JsxEmit: { React: 2 }
      }
    }
  };
}

describe("languageForPath", () => {
  it("maps common extensions to Monaco language ids", () => {
    expect(languageForPath("src/routes/repositories/CodeEditor.tsx")).toBe("typescript");
    expect(languageForPath("main.ts")).toBe("typescript");
    expect(languageForPath("bundle.mjs")).toBe("javascript");
    expect(languageForPath("app.jsx")).toBe("javascript");
    expect(languageForPath("lib.rs")).toBe("rust");
    expect(languageForPath("script.py")).toBe("python");
    expect(languageForPath("Program.cs")).toBe("csharp");
    expect(languageForPath("data.json")).toBe("json");
    expect(languageForPath("theme.css")).toBe("css");
    expect(languageForPath("page.html")).toBe("html");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("Cargo.toml")).toBe("ini");
    expect(languageForPath("deploy.yaml")).toBe("yaml");
    expect(languageForPath("run.sh")).toBe("shell");
    expect(languageForPath("build.ps1")).toBe("powershell");
  });

  it("matches extension-less names by their full lowercased name", () => {
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("some/dir/dockerfile")).toBe("dockerfile");
  });

  it("falls back to plaintext for unknown or extension-less files", () => {
    expect(languageForPath("LICENSE")).toBe("plaintext");
    expect(languageForPath("notes.mystery")).toBe("plaintext");
    expect(languageForPath(".gitignore")).toBe("plaintext");
  });
});

describe("configureLanguageDefaults", () => {
  it("tunes the TS/JS language service once (guarded against re-registration)", () => {
    const first = makeMonaco();
    configureLanguageDefaults(first as never);

    const tsd = first.languages.typescript.typescriptDefaults;
    const jsd = first.languages.typescript.javascriptDefaults;

    // Both language defaults get the in-file compiler options...
    expect(tsd.setCompilerOptions).toHaveBeenCalledTimes(1);
    expect(tsd.setCompilerOptions.mock.calls[0]?.[0]).toMatchObject({
      target: 99,
      module: 99,
      moduleResolution: 2,
      jsx: 2,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      allowJs: true,
      checkJs: false
    });
    // ...single-file semantic diagnostics off, syntax on...
    expect(tsd.setDiagnosticsOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: false
    });
    // ...eager model sync on, mirrored onto javascript defaults.
    expect(tsd.setEagerModelSync).toHaveBeenCalledWith(true);
    expect(jsd.setCompilerOptions).toHaveBeenCalledTimes(1);
    expect(jsd.setEagerModelSync).toHaveBeenCalledWith(true);

    // The guard means a second call is a no-op (the service is process-wide, configured once).
    const second = makeMonaco();
    configureLanguageDefaults(second as never);
    expect(second.languages.typescript.typescriptDefaults.setCompilerOptions).not.toHaveBeenCalled();
  });
});

describe("CodeEditor", () => {
  it("mounts the (mocked) editor without throwing", () => {
    const { container } = render(
      <CodeEditor path="main.ts" value="const x = 1;" onChange={() => {}} onSave={() => {}} />
    );
    expect(container).toBeTruthy();
  });

  it("mounts read-only for a truncated file", () => {
    const { container } = render(
      <CodeEditor
        path="big.log"
        value={"x".repeat(50)}
        onChange={() => {}}
        onSave={() => {}}
        readOnly
      />
    );
    expect(container).toBeTruthy();
  });
});
