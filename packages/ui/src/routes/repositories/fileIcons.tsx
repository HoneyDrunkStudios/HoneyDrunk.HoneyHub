import type { ReactElement } from "react";

// Lightweight, dependency-free file-type icons for the Repositories IDE. Each icon is a small
// inline SVG monogram badge (a coloured rounded square with a 1-2 char label) so file types are
// eyeball-able while scrolling the tree or scanning tabs — no icon-font, no remote assets, so it
// stays offline in the Tauri shell. `fileIconSpec` (the pure {label,color} lookup) is exported for
// tests; `fileIcon`/`folderIcon` render the SVG.

export interface FileIconSpec {
  /** The 1-2 character monogram drawn in the badge. Empty means the generic "lines" glyph. */
  label: string;
  /** The badge's accent colour (hex). */
  color: string;
}

// On-brand-ish accent colours: neon-blue for TS, honey/gold for config, purple for .NET, pink for
// data/markup. Each key category is visually distinct from its neighbours.
const BLUE = "#4dd6ff";
const CYAN = "#38bdf8";
const GOLD = "#e5c02c";
const AMBER = "#e0a83a";
const PURPLE = "#9d7bff";
const VIOLET = "#7b5cff";
const ORANGE = "#e08a3a";
const RUST = "#d0916a";
const PINK = "#e04f8f";
const CORAL = "#e0663a";
const GREEN = "#89c46a";
const SKY = "#4a7fd0";
const MUTED = "#8b86a3";

/** Extension → badge. Keyed on the lowercased extension (no dot). */
const EXT_ICON: Record<string, FileIconSpec> = {
  ts: { label: "TS", color: BLUE },
  mts: { label: "TS", color: BLUE },
  cts: { label: "TS", color: BLUE },
  tsx: { label: "TX", color: CYAN },
  js: { label: "JS", color: GOLD },
  mjs: { label: "JS", color: GOLD },
  cjs: { label: "JS", color: GOLD },
  jsx: { label: "JX", color: GOLD },
  json: { label: "{}", color: AMBER },
  jsonc: { label: "{}", color: AMBER },
  cs: { label: "C#", color: PURPLE },
  csproj: { label: "PR", color: VIOLET },
  sln: { label: "SL", color: VIOLET },
  razor: { label: "@", color: VIOLET },
  cshtml: { label: "@", color: VIOLET },
  sql: { label: "DB", color: ORANGE },
  yaml: { label: "YM", color: PINK },
  yml: { label: "YM", color: PINK },
  md: { label: "MD", color: SKY },
  markdown: { label: "MD", color: SKY },
  mdx: { label: "MD", color: SKY },
  css: { label: "#", color: BLUE },
  scss: { label: "#", color: PINK },
  less: { label: "#", color: SKY },
  html: { label: "<>", color: CORAL },
  htm: { label: "<>", color: CORAL },
  xml: { label: "<>", color: GREEN },
  svg: { label: "IM", color: PURPLE },
  rs: { label: "RS", color: RUST },
  toml: { label: "TO", color: RUST },
  ini: { label: "IN", color: MUTED },
  cfg: { label: "IN", color: MUTED },
  conf: { label: "IN", color: MUTED },
  py: { label: "PY", color: SKY },
  rb: { label: "RB", color: CORAL },
  go: { label: "GO", color: BLUE },
  java: { label: "JV", color: ORANGE },
  kt: { label: "KT", color: PURPLE },
  swift: { label: "SW", color: ORANGE },
  c: { label: "C", color: SKY },
  h: { label: "H", color: SKY },
  cpp: { label: "C+", color: SKY },
  php: { label: "PH", color: PURPLE },
  sh: { label: "SH", color: GREEN },
  bash: { label: "SH", color: GREEN },
  zsh: { label: "SH", color: GREEN },
  ps1: { label: "PS", color: SKY },
  bat: { label: "BT", color: GREEN },
  cmd: { label: "BT", color: GREEN },
  png: { label: "IM", color: GREEN },
  jpg: { label: "IM", color: GREEN },
  jpeg: { label: "IM", color: GREEN },
  gif: { label: "IM", color: GREEN },
  webp: { label: "IM", color: GREEN },
  ico: { label: "IM", color: GREEN },
  lock: { label: "LK", color: MUTED },
  txt: { label: "TX", color: MUTED }
};

/** Full-name (lowercased) → badge, for extension-less or special files. Checked before extensions. */
const NAME_ICON: Record<string, FileIconSpec> = {
  ".gitignore": { label: "GI", color: CORAL },
  ".gitattributes": { label: "GI", color: CORAL },
  ".editorconfig": { label: "EC", color: MUTED },
  dockerfile: { label: "DK", color: SKY },
  makefile: { label: "MK", color: AMBER },
  "cargo.toml": { label: "TO", color: RUST },
  "cargo.lock": { label: "LK", color: MUTED },
  "package.json": { label: "{}", color: GREEN },
  "package-lock.json": { label: "LK", color: MUTED },
  license: { label: "LI", color: MUTED }
};

/** The lowercased last path segment. Tolerant of mixed `/` and `\` separators. */
function baseName(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
  return base.toLowerCase();
}

/** The extension (lowercased, no dot), or "" for a dotfile / extension-less name. */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot + 1);
}

/** Resolve the {label,color} badge for a file name or path. Falls back to a neutral generic
    glyph for unknown types. Pure and exported so tests can assert distinct icons per type. */
export function fileIconSpec(nameOrPath: string): FileIconSpec {
  const base = baseName(nameOrPath);
  const byName = NAME_ICON[base];
  if (byName !== undefined) {
    return byName;
  }
  const byExt = EXT_ICON[extensionOf(base)];
  return byExt ?? { label: "", color: MUTED };
}

/** A small inline-SVG monogram badge for a file, keyed on its name/extension. Decorative
    (`aria-hidden`), so it never changes a row/tab's accessible name. */
export function fileIcon(nameOrPath: string): ReactElement {
  const { label, color } = fileIconSpec(nameOrPath);
  return (
    <svg className="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="3.2"
        fill={color}
        fillOpacity="0.15"
        stroke={color}
        strokeOpacity="0.55"
        strokeWidth="1"
      />
      {label.length > 0 ? (
        <text
          x="8"
          y="10.9"
          textAnchor="middle"
          fontSize={label.length > 1 ? "6" : "8"}
          fontFamily="ui-monospace, 'Cascadia Code', monospace"
          fontWeight="700"
          fill={color}
        >
          {label}
        </text>
      ) : (
        <path d="M4.5 6.5h7M4.5 9h5.5M4.5 11.5h4" stroke={color} strokeWidth="1" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** A folder glyph, honey when open, dimmer when closed. Decorative (`aria-hidden`). */
export function folderIcon(open: boolean): ReactElement {
  const color = open ? "#f4b731" : "#c9a24a";
  return (
    <svg className="file-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {open ? (
        <path
          d="M2 4.4c0-.6.45-1 1-1h3.1l1.2 1.3H13c.55 0 1 .45 1 1v.5H4.6c-.5 0-.94.32-1.08.8L2 12.4V4.4Z M2.3 13l1.5-4.7c.08-.26.32-.44.6-.44H14l-1.5 4.7c-.08.26-.32.44-.6.44H2.3Z"
          fill={color}
          fillOpacity="0.28"
          stroke={color}
          strokeOpacity="0.7"
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2 4.4c0-.6.45-1 1-1h3.1l1.2 1.3H13c.55 0 1 .45 1 1V12c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4.4Z"
          fill={color}
          fillOpacity="0.22"
          stroke={color}
          strokeOpacity="0.7"
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
