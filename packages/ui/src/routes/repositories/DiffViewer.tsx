import { DiffEditor } from "@monaco-editor/react";
import type { ReactElement } from "react";

import { configureMonaco, languageForPath, MONO_FONT } from "./CodeEditor";

export interface DiffViewerProps {
  /** The file's path; drives language detection for both sides. */
  path: string;
  /** The `HEAD` (committed) content — the left side. Empty for a newly-added file. */
  original: string;
  /** The working-tree content — the right side. Empty for a deleted file. */
  modified: string;
}

/**
 * A Monaco-backed side-by-side diff for the Repositories center pane. Shares the honeypunk
 * theme + bundled workers with {@link CodeEditor} via {@link configureMonaco}, so it renders
 * offline with full syntax highlighting. Read-only. A newly-added file arrives with an empty
 * `original` (all-added); a deleted file with an empty `modified` (all-removed). Loaded lazily
 * so the base bundle stays light until a diff is opened.
 */
export default function DiffViewer({
  path,
  original,
  modified
}: Readonly<DiffViewerProps>): ReactElement {
  return (
    <DiffEditor
      className="repos-monaco"
      theme="honeypunk"
      language={languageForPath(path)}
      original={original}
      modified={modified}
      beforeMount={configureMonaco}
      loading={<div className="file-viewer empty">Loading diff…</div>}
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        fontFamily: MONO_FONT,
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderWhitespace: "selection",
        smoothScrolling: true,
        roundedSelection: false,
        padding: { top: 12, bottom: 12 },
        fontLigatures: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
      }}
    />
  );
}
