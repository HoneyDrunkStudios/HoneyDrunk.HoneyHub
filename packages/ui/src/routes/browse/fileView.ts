import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";

// Read-only file rendering for the Browse view: markdown → HTML, and source → a
// syntax-highlighted HTML string. highlight.js classifies tokens (keyword, string,
// function title, variable, comment, number…) the SAME way across languages, and our
// stylesheet themes those classes once — so colors are standardized across languages
// (packet 09 §3 viewer requirement). Output is for `dangerouslySetInnerHTML`: markdown
// renders with HTML disabled (user text is escaped); highlight output is hljs spans.

/** Map a filename to a highlight.js language id. Unknown extensions fall back to
    auto-detection. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  dockerfile: "dockerfile",
  makefile: "makefile",
  diff: "diff",
  patch: "diff"
};

/** The file extension (lowercased, no dot), or "" if none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    // Extension-less names like "Dockerfile"/"Makefile" map by their full name.
    return base.toLowerCase();
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Whether a file should render as markdown rather than highlighted source. */
export function isMarkdownFile(name: string): boolean {
  const ext = fileExtension(name);
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

/** Resolve a highlight.js language id for a filename, if known. */
function languageFor(name: string): string | undefined {
  const ext = fileExtension(name);
  const mapped = EXTENSION_LANGUAGE[ext];
  if (mapped !== undefined && hljs.getLanguage(mapped) !== undefined) {
    return mapped;
  }
  return undefined;
}

/** Highlight source code to an HTML string (hljs token spans). Uses the filename's
    language when known, else auto-detection; falls back to escaped plain text. */
export function highlightSource(content: string, name: string): string {
  try {
    const language = languageFor(name);
    if (language !== undefined) {
      return hljs.highlight(content, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(content).value;
  } catch {
    return escapeHtml(content);
  }
}

// Markdown renderer with HTML disabled (so file text can't inject markup) and fenced
// code blocks highlighted through the same hljs pipeline.
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (code, lang) => {
    try {
      if (lang && hljs.getLanguage(lang) !== undefined) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }
});

/** Render markdown source to an HTML string (safe: no raw HTML passthrough). */
export function renderMarkdown(content: string): string {
  return markdown.render(content);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
