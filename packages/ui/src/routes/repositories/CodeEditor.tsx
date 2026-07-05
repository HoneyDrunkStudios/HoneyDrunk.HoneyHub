import { useCallback, useRef } from "react";
import type { ReactElement } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { BeforeMount, Monaco, OnChange, OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import yamlWorker from "monaco-yaml/yaml.worker?worker";
import { configureMonacoYaml } from "monaco-yaml";

// HoneyHub runs inside a Tauri shell with no network at runtime, so Monaco must be bundled
// locally. Three things make that happen:
//   1. `loader.config({ monaco })` points @monaco-editor/react at the Monaco we imported and
//      Vite bundled, instead of its default CDN download.
//   2. Vite's `?worker` imports pull each language worker in as a local chunk, wired up through
//      `MonacoEnvironment.getWorker` below (JSON/CSS/HTML/TS/YAML each get their own; everything
//      else falls back to the base editor worker).
//   3. `configureMonacoYaml` (see `configureMonaco`) registers monaco-yaml against the same
//      bundled Monaco with `enableSchemaRequest: false`, so YAML completion/validation is offline.
// SQL and Razor need no worker: they ride the full `monaco-editor` bundle's basic-languages
// tokenizers (syntax highlighting + basic word completions); Razor's language features reuse the
// HTML worker. Semantic language servers for those are the future ADR-0102 slice.
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
  if (label === "yaml") {
    return new yamlWorker();
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
  cshtml: "razor",
  razor: "razor",
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

// The "honeypunk" theme: HoneyHub's dark palette carried into the editor as a real, legible
// colour scheme (not a wash of grey/white). The palette maps each token family to a distinct,
// on-brand hue so code reads at a glance:
//   keywords    honey       #f4b731   control flow  neon-pink   #ff6fb5
//   types/class purple      #b79cff   functions     neon-blue   #4dd6ff
//   properties  light-blue  #8fdcff   strings       warm-gold   #e9c46a
//   numbers     orange      #ff9e64   constants     orange      #ff9e64
//   operators   muted       #9a93b4   punctuation   muted       #8b86a3
//   comments    dim italic  #6f6a89   tags          pink        #ff8ab3
// Monaco matches the longest token prefix, so the base names below also colour their language
// variants (e.g. `keyword.sql`, `string.yaml`, `comment.cs`). Base vs-dark covers anything else.
const HONEYPUNK_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "ece7f3" },
    // Comments recede but stay readable on the dark background.
    { token: "comment", foreground: "6f6a89", fontStyle: "italic" },
    { token: "comment.doc", foreground: "6f6a89", fontStyle: "italic" },
    // Keywords + storage/modifiers glow honey; control flow branches to neon-pink.
    { token: "keyword", foreground: "f4b731" },
    { token: "keyword.operator", foreground: "f4b731" },
    { token: "keyword.control", foreground: "ff6fb5" },
    { token: "keyword.control.flow", foreground: "ff6fb5" },
    { token: "keyword.flow", foreground: "ff6fb5" },
    { token: "storage", foreground: "f9c85b" },
    { token: "storage.type", foreground: "f9c85b" },
    { token: "storage.modifier", foreground: "f9c85b" },
    // Strings warm gold; escapes brighter; regexp its own warm tone.
    { token: "string", foreground: "e9c46a" },
    { token: "string.escape", foreground: "ffcf4d" },
    { token: "constant.character.escape", foreground: "ffcf4d" },
    { token: "string.regexp", foreground: "f6b57a" },
    { token: "regexp", foreground: "f6b57a" },
    { token: "string.value.json", foreground: "e9c46a" },
    { token: "string.key.json", foreground: "4dd6ff" },
    { token: "string.link.md", foreground: "4dd6ff" },
    // Numbers + constants (true/false/null) share a warm orange.
    { token: "number", foreground: "ff9e64" },
    { token: "number.hex", foreground: "ff9e64" },
    { token: "constant", foreground: "ff9e64" },
    { token: "constant.numeric", foreground: "ff9e64" },
    { token: "constant.language", foreground: "ff9e64" },
    { token: "constant.language.boolean", foreground: "ff9e64" },
    { token: "keyword.json", foreground: "ff9e64" },
    // Types / classes / namespaces in violet.
    { token: "type", foreground: "b79cff" },
    { token: "type.identifier", foreground: "b79cff" },
    { token: "entity.name.type", foreground: "b79cff" },
    { token: "entity.name.class", foreground: "b79cff" },
    { token: "namespace", foreground: "b79cff" },
    { token: "struct", foreground: "b79cff" },
    { token: "interface", foreground: "b79cff" },
    { token: "support.type", foreground: "b79cff" },
    { token: "support.class", foreground: "b79cff" },
    // Decorators / annotations in a lighter purple.
    { token: "annotation", foreground: "c9a6ff" },
    { token: "meta.decorator", foreground: "c9a6ff" },
    { token: "decorator", foreground: "c9a6ff" },
    // Functions / methods in neon-blue; predefined identifiers (this, super) too.
    { token: "function", foreground: "4dd6ff" },
    { token: "entity.name.function", foreground: "4dd6ff" },
    { token: "support.function", foreground: "4dd6ff" },
    { token: "meta.function-call", foreground: "4dd6ff" },
    { token: "variable.predefined", foreground: "4dd6ff" },
    // Members / properties in a lighter blue so field access is distinct from calls.
    { token: "property", foreground: "8fdcff" },
    { token: "variable.other.property", foreground: "8fdcff" },
    { token: "member", foreground: "8fdcff" },
    { token: "key", foreground: "8fdcff" },
    // Plain identifiers/variables read as near-white text; parameters a touch dimmer.
    { token: "variable", foreground: "ece7f3" },
    { token: "variable.parameter", foreground: "d7cfe6" },
    { token: "parameter", foreground: "d7cfe6" },
    { token: "identifier", foreground: "ece7f3" },
    // Operators + punctuation stay muted but legible.
    { token: "operator", foreground: "9a93b4" },
    { token: "operators", foreground: "9a93b4" },
    { token: "delimiter", foreground: "8b86a3" },
    { token: "delimiter.bracket", foreground: "8b86a3" },
    { token: "delimiter.parenthesis", foreground: "8b86a3" },
    { token: "delimiter.square", foreground: "8b86a3" },
    { token: "delimiter.angle", foreground: "8b86a3" },
    { token: "delimiter.html", foreground: "8b86a3" },
    { token: "delimiter.xml", foreground: "8b86a3" },
    // Markup: tag names pink, attributes honey, attribute values gold (HTML / Razor / XML).
    { token: "tag", foreground: "ff8ab3" },
    { token: "tag.id", foreground: "ff8ab3" },
    { token: "metatag", foreground: "ff8ab3" },
    { token: "metatag.content.html", foreground: "e9c46a" },
    { token: "attribute.name", foreground: "f4b731" },
    { token: "attribute.value", foreground: "e9c46a" },
    // Markdown headings/emphasis.
    { token: "keyword.md", foreground: "f4b731" },
    { token: "emphasis", fontStyle: "italic" },
    { token: "strong", fontStyle: "bold" }
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

let themeDefined = false;

/** Register the honeypunk theme once. */
function defineHoneypunkTheme(m: Monaco): void {
  if (themeDefined) {
    return;
  }
  themeDefined = true;
  m.editor.defineTheme("honeypunk", HONEYPUNK_THEME);
}

let languageDefaultsConfigured = false;

/**
 * Tune Monaco's built-in TypeScript/JavaScript language service for the best IN-FILE IntelliSense
 * (completions, hover, signature help stay on). Runs once; guarded against double-registration.
 *
 * Diagnostics: only the single open file is ever in the model, so cross-file semantic checks would
 * surface false "cannot find module" errors. We keep syntax squiggles but drop semantic validation.
 * Project-aware IntelliSense across files is a later LSP effort; this is the in-file service.
 */
export function configureLanguageDefaults(m: Monaco): void {
  if (languageDefaultsConfigured) {
    return;
  }
  languageDefaultsConfigured = true;
  const ts = m.languages.typescript;
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.React,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowJs: true,
    checkJs: false
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), ...compilerOptions });
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    defaults.setEagerModelSync(true);
  }
}

let yamlConfigured = false;

/**
 * Register monaco-yaml against the bundled Monaco once, wiring real YAML completion/validation/
 * hover through its worker (see `workerFor`). `enableSchemaRequest: false` keeps it fully offline
 * (no schema fetches over the network), matching the Tauri no-network runtime.
 */
export function configureYamlDefaults(m: Monaco): void {
  if (yamlConfigured) {
    return;
  }
  yamlConfigured = true;
  configureMonacoYaml(m as Parameters<typeof configureMonacoYaml>[0], {
    enableSchemaRequest: false,
    completion: true,
    validate: true,
    hover: true,
    schemas: []
  });
}

/** Run once, right before the first editor mounts: theme + language-service tuning + YAML wiring.
    Exported so the side-by-side `DiffViewer` mounts against the same honeypunk theme + workers. */
export const configureMonaco: BeforeMount = (m) => {
  defineHoneypunkTheme(m);
  configureLanguageDefaults(m);
  configureYamlDefaults(m);
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
export const MONO_FONT =
  '"JetBrains Mono", "Cascadia Code", ui-monospace, "Courier New", monospace';

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
    // never gets its "save page" dialog. Undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) and the find/
    // replace widgets (Ctrl/Cmd+F, Ctrl/Cmd+H) are Monaco-native and left enabled — nothing here
    // disables the model's edit history or the find controller.
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
      // `path` gives each open file its own Monaco model, so switching tabs preserves each file's
      // undo/redo history and view state (`keepCurrentModel` keeps the model alive across swaps).
      path={path}
      keepCurrentModel
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
        // Keep the built-in find widget (Ctrl/Cmd+F) and its replace mode (Ctrl/Cmd+H) enabled.
        find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "always" },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
      }}
    />
  );
}
