import { useMemo } from "react";
import type { FileContents } from "@honeydrunk/honeyhub-types";
import { highlightSource, isMarkdownFile, renderMarkdown } from "./fileView";

export interface FileViewerProps {
  file?: FileContents | undefined;
  error?: string | undefined;
  loading?: boolean | undefined;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Read-only viewer: markdown files render to HTML, everything else renders as
    syntax-highlighted source. Never editable (no inputs); the title says so. */
export function FileViewer({ file, error, loading }: Readonly<FileViewerProps>) {
  const rendered = useMemo(() => {
    if (file === undefined) {
      return undefined;
    }
    if (isMarkdownFile(file.path)) {
      return { kind: "markdown" as const, html: renderMarkdown(file.content) };
    }
    return { kind: "code" as const, html: highlightSource(file.content, file.path) };
  }, [file]);

  if (loading === true) {
    return <div className="file-viewer empty">Loading…</div>;
  }
  if (error !== undefined) {
    return (
      <div className="file-viewer empty">
        <p role="alert" className="settings-error">
          {error}
        </p>
      </div>
    );
  }
  if (file === undefined || rendered === undefined) {
    return <div className="file-viewer empty">Select a file to view its source.</div>;
  }

  return (
    <div className="file-viewer">
      <header className="file-viewer-head">
        <span className="file-viewer-name">{basename(file.path)}</span>
        <span className="file-viewer-meta">
          read-only
          {file.truncated ? " · truncated (file too large)" : ""}
        </span>
      </header>
      {rendered.kind === "markdown" ? (
        <article
          className="markdown-body"
          // Rendered by markdown-it with raw HTML disabled (text escaped); only hljs
          // token spans are injected, so this is safe.
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      ) : (
        <pre className="code-view">
          <code
            className="hljs"
            // hljs token spans over escaped source; safe to inject.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </pre>
      )}
    </div>
  );
}
