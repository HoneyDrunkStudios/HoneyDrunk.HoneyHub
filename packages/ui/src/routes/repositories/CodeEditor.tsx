import { useCallback, useRef } from "react";
import type { ReactElement } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { BeforeMount, OnChange, OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// HoneyHub runs inside a Tauri shell with no network at runtime, so Monaco must be bundled
// locally. Two things make that happen:
//   1. `loader.config({ monaco })` points @monaco-editor/react at the Monaco we imported and
//      Vite bundled, instead of its default CDN download.
//   2. Vite's `?worker` imports pull each language worker in as a local chunk, wired up through
//      `MonacoEnvironment.getWorker` below (JSON/CSS/HTML/TS each get their own; everything else
//      falls back to the base editor worker).
function workerFor(label: string): Worker {
  if (label === "json") {
    return new jsonWorker();
  }
  if (label === "css" || label === "scss" || label === "less") {
    return new cssWorker();
  }
  if (label === "html" || label === "handlebars" || label === "razor") {
    return new htmlWorker();
  }
  if (label === "typescript" || label === "javascript") {
    return new tsWorker();
  }
  return new editorWorker();
}

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_workerId, label) => workerFor(label)
};

loader.config({ monaco });

// Map a filename to a Monaco language id from its extension. Extension-less names (Dockerfile,
// Makefile) match on their full lowercased name. Unknown types fall back to plaintext, which
// still renders cleanly; it just carries no tokenizer. Kept in sync in spirit with the Browse
// view's highlight.js map, but expressed in Monaco's language ids.
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rs: "rust",
  cs: "csharp",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  php: "php",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  dockerfile: "dockerfile"
};

/** The file extension (lowercased, no dot), or the full name for extension-less files. */
function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return base.toLowerCase();
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Resolve a Monaco language id for a filename, falling back to "plaintext". */
export function languageForPath(path: string): string {
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? "plaintext";
}

// The "honeypunk" theme: HoneyHub's dark palette carried into the editor. Keywords glow honey,
// strings a warm gold, functions/tags a neon blue, types/decorators a violet, numbers a soft
// honey, and comments recede. Base vs-dark so anything we don't name still reads sensibly.
const HONEYPUNK_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "ece7f3" },
    { token: "comment", foreground: "7d7796", fontStyle: "italic" },
    { token: "comment.doc", foreground: "7d7796", fontStyle: "italic" },
    { token: "keyword", foreground: "f4b731" },
    { token: "keyword.control", foreground: "f4b731" },
    { token: "keyword.operator", foreground: "f4b731" },
    { token: "storage", foreground: "f4b731" },
    { token: "storage.type", foreground: "f4b731" },
    { token: "keyword.flow", foreground: "ffcf4d" },
    { token: "string", foreground: "e9c46a" },
    { token: "string.escape", foreground: "ffcf4d" },
    { token: "string.regexp", foreground: "e9c46a" },
    { token: "regexp", foreground: "e9c46a" },
    { token: "string.value.json", foreground: "e9c46a" },
    { token: "string.key.json", foreground: "4dd6ff" },
    { token: "number", foreground: "ffc978" },
    { token: "number.hex", foreground: "ffc978" },
    { token: "constant", foreground: "ffc978" },
    { token: "constant.numeric", foreground: "ffc978" },
    { token: "constant.language", foreground: "ffc978" },
    { token: "keyword.json", foreground: "ffc978" },
    { token: "type", foreground: "9d7bff" },
    { token: "type.identifier", foreground: "9d7bff" },
    { token: "entity.name.type", foreground: "9d7bff" },
    { token: "entity.name.class", foreground: "9d7bff" },
    { token: "namespace", foreground: "9d7bff" },
    { token: "struct", foreground: "9d7bff" },
    { token: "interface", foreground: "9d7bff" },
    { token: "support.type", foreground: "9d7bff" },
    { token: "annotation", foreground: "9d7bff" },
    { token: "meta.decorator", foreground: "9d7bff" },
    { token: "decorator", foreground: "9d7bff" },
    { token: "function", foreground: "4dd6ff" },
    { token: "entity.name.function", foreground: "4dd6ff" },
    { token: "support.function", foreground: "4dd6ff" },
    { token: "variable.predefined", foreground: "4dd6ff" },
    { token: "variable", foreground: "ece7f3" },
    { token: "variable.parameter", foreground: "d7cfe6" },
    { token: "identifier", foreground: "ece7f3" },
    { token: "operator", foreground: "b4adc9" },
    { token: "delimiter", foreground: "b4adc9" },
    { token: "delimiter.html", foreground: "7d7796" },
    { token: "delimiter.xml", foreground: "7d7796" },
    { token: "tag", foreground: "4dd6ff" },
    { token: "metatag", foreground: "4dd6ff" },
    { token: "attribute.name", foreground: "f4b731" },
    { token: "attribute.value", foreground: "e9c46a" },
    { token: "key", foreground: "f4b731" },
    { token: "keyword.md", foreground: "f4b731" },
    { token: "string.link.md", foreground: "4dd6ff" }
  ],
  colors: {
    "editor.background": "#0b0a11",
    "editor.foreground": "#ece7f3",
    "editorLineNumber.foreground": "#4d4860",
    "editorLineNumber.activeForeground": "#b4adc9",
    "editor.lineHighlightBackground": "#151221",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#33305a",
    "editor.inactiveSelectionBackground": "#242137",
    "editor.selectionHighlightBackground": "#2a2740",
    "editorCursor.foreground": "#f5b700",
    "editorWhitespace.foreground": "#241f33",
    "editorIndentGuide.background1": "#1c1a28",
    "editorIndentGuide.activeBackground1": "#3b3358",
    "editorBracketMatch.background": "#00000000",
    "editorBracketMatch.border": "#f5b70088",
    "editorGutter.background": "#0b0a11",
    "editorWidget.background": "#15121f",
    "editorWidget.border": "#272338",
    "editorSuggestWidget.background": "#15121f",
    "editorSuggestWidget.border": "#272338",
    "editorSuggestWidget.selectedBackground": "#241f33",
    "editorHoverWidget.background": "#15121f",
    "editorHoverWidget.border": "#272338",
    "minimap.background": "#0b0a11",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff22",
    "scrollbarSlider.activeBackground": "#ffffff33"
  }
};

let configured = false;

// Run once, right before the first editor mounts. Registers the theme and, because the model only
// ever holds the single open file, silences project-wide semantic diagnostics (they would surface
// false "cannot find module" errors). Syntax highlighting and in-file IntelliSense stay on.
const configureMonaco: BeforeMount = (m) => {
  if (configured) {
    return;
  }
  configured = true;
  m.editor.defineTheme("honeypunk", HONEYPUNK_THEME);
  const ts = m.languages.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      jsx: ts.JsxEmit.React,
      allowNonTsExtensions: true
    });
  }
};

export interface CodeEditorProps {
  /** The file's path; drives language detection and the model key. */
  path: string;
  /** The current editor text (controlled). */
  value: string;
  /** Fires on every edit with the new text. */
  onChange: (value: string) => void;
  /** Fires on Ctrl/Cmd+S (or the pane's Save button, wired by the parent). */
  onSave: () => void;
  /** When true, the editor is view-only (e.g. a truncated file). */
  readOnly?: boolean;
}

// The app's monospace stack, spelled out (not `var(--font-mono)`) so Monaco's canvas-based glyph
// measurement gets a concrete family rather than an unresolved custom property.
const MONO_FONT = '"JetBrains Mono", "Cascadia Code", ui-monospace, "Courier New", monospace';

/**
 * A Monaco-backed code editor for the Repositories file pane. Full syntax highlighting via the
 * honeypunk theme, built-in IntelliSense for the languages with a bundled worker (TS/JS/JSON/
 * CSS/HTML), and Ctrl/Cmd+S wired to the parent's save. Loaded lazily so the base bundle stays
 * light until a file is opened.
 */
export default function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false
}: Readonly<CodeEditorProps>): ReactElement {
  // Keep the latest onSave reachable from the editor command without re-registering it.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleMount = useCallback<OnMount>((editor, m) => {
    // Save on Ctrl/Cmd+S from inside the editor; Monaco swallows the keystroke so the browser
    // never gets its "save page" dialog.
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onSaveRef.current());
  }, []);

  const handleChange = useCallback<OnChange>(
    (next) => {
      onChange(next ?? "");
    },
    [onChange]
  );

  return (
    <Editor
      className="repos-monaco"
      theme="honeypunk"
      language={languageForPath(path)}
      value={value}
      beforeMount={configureMonaco}
      onMount={handleMount}
      onChange={handleChange}
      loading={<div className="file-viewer empty">Loading editor…</div>}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontFamily: MONO_FONT,
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: "selection",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        roundedSelection: false,
        padding: { top: 12, bottom: 12 },
        fontLigatures: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
      }}
    />
  );
}
