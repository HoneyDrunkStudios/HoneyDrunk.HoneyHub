import { useCallback, useEffect, useRef, useState } from "react";
import type { DirListing, FileContents, SearchResults } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { FileViewer } from "./FileViewer";

export interface BrowseViewProps {
  client: WireClient;
  /** The repo locations (allowlisted roots) the user picked — the starting points. */
  workspaceRoots: string[];
  active: boolean;
}

/** Join a child name onto a parent path, honoring the platform separator implied by
    the parent (top-level entries are already absolute roots). */
function childPath(parent: string, name: string): string {
  if (parent.length === 0) {
    return name;
  }
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

/** Read-only repo/file browser (packet 09 §3): navigate the picked locations, search
    files by name, and view source (markdown rendered, code highlighted). All disk
    access goes through the bridge; reads are gated to the allowlisted roots. */
export function BrowseView({ client, workspaceRoots, active }: Readonly<BrowseViewProps>) {
  // The current directory listing; undefined = the top-level list of repo locations.
  const [dir, setDir] = useState<DirListing | undefined>(undefined);
  const [file, setFile] = useState<FileContents | undefined>(undefined);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [fileLoading, setFileLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);

  // Path of the file currently being fetched, so a slower earlier read can't clobber
  // a newer one when its event finally arrives.
  const pendingFile = useRef<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "dir_listing") {
        setDir(payload.listing);
      } else if (payload.kind === "file_contents") {
        if (pendingFile.current === undefined || payload.file.path === pendingFile.current) {
          setFile(payload.file);
          setFileLoading(false);
          setFileError(undefined);
        }
      } else if (payload.kind === "search_results") {
        setResults(payload.results);
        setSearching(false);
      }
    });
    return unsubscribe;
  }, [client]);

  const openDir = (path: string) => {
    setResults(undefined);
    setSearchError(undefined);
    setQuery("");
    void client.browseDir(path).catch(() => undefined);
  };

  const openLocations = () => {
    setDir(undefined);
    setResults(undefined);
    setQuery("");
    setSearchError(undefined);
  };

  const goUp = () => {
    const parent = dir?.parent;
    if (parent === undefined || parent.length === 0) {
      openLocations();
    } else {
      openDir(parent);
    }
  };

  const openFile = (path: string) => {
    pendingFile.current = path;
    setFile(undefined);
    setFileError(undefined);
    setFileLoading(true);
    void client.readFile(path).catch((cause: unknown) => {
      // Only surface the error if this is still the file we're waiting for.
      if (pendingFile.current === path) {
        setFileLoading(false);
        setFileError(cause instanceof Error ? cause.message : "could not read file");
      }
    });
  };

  // Keep the current dir + open file paths in refs so the poll/focus handlers re-read the
  // latest without re-subscribing.
  const dirPathRef = useRef<string | undefined>(undefined);
  dirPathRef.current = dir?.path;
  const filePathRef = useRef<string | undefined>(undefined);
  filePathRef.current = file?.path;

  // Re-read the current folder + open file from disk, so the view reflects repo changes.
  // Silent: it doesn't toggle loading state (the events just replace the content), so a
  // periodic refresh never flickers the UI.
  const refresh = useCallback(() => {
    const path = dirPathRef.current;
    if (path !== undefined && path.length > 0) {
      void client.browseDir(path).catch(() => undefined);
    }
    const filePath = filePathRef.current;
    if (filePath !== undefined) {
      pendingFile.current = filePath;
      void client.readFile(filePath).catch(() => undefined);
    }
  }, [client]);

  // While the Browse tab is open, keep it fresh: re-read on window focus and on a light
  // interval, so files added/removed/edited in the selected repos show up (poll, not a
  // filesystem watcher — "within a few seconds" with zero extra plumbing).
  useEffect(() => {
    if (!active) {
      return;
    }
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const interval = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [active, refresh]);

  // Debounced filename search within the current directory subtree.
  useEffect(() => {
    const root = dir?.path;
    const trimmed = query.trim();
    if (root === undefined || root.length === 0 || trimmed.length === 0) {
      setResults(undefined);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(undefined);
    const handle = setTimeout(() => {
      void client.searchFiles(root, trimmed).catch((cause: unknown) => {
        setSearching(false);
        setSearchError(cause instanceof Error ? cause.message : "search failed");
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [query, dir, client]);

  if (!active) {
    return null;
  }

  const showingResults = query.trim().length > 0 && dir !== undefined;

  return (
    <section className="browse" aria-label="Browse">
      <div className="browse-pane browse-nav">
        <header className="browse-head">
          <div>
            <p className="eyebrow">Browse</p>
            <h2>{dir === undefined ? "Your repos" : basename(dir.path)}</h2>
          </div>
          {dir !== undefined && (
            <button
              type="button"
              className="browse-refresh"
              onClick={refresh}
              aria-label="Refresh folder"
            >
              Refresh
            </button>
          )}
        </header>

        <div className="browse-breadcrumb">
          <button type="button" className="crumb" onClick={openLocations}>
            Locations
          </button>
          {dir !== undefined && (
            <>
              <span className="crumb-sep">/</span>
              <span className="crumb-path" title={dir.path}>
                {dir.path}
              </span>
              <button type="button" className="crumb up" onClick={goUp}>
                Up
              </button>
            </>
          )}
        </div>

        <input
          className="browse-search"
          aria-label="Search files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            dir === undefined ? "Open a location to search files" : "Search files in this folder…"
          }
          disabled={dir === undefined}
        />

        {searchError !== undefined && (
          <p role="alert" className="settings-error">
            {searchError}
          </p>
        )}

        <ul className="browse-list" aria-label="Entries">
          {showingResults ? (
            searching ? (
              <li className="browse-hint">Searching…</li>
            ) : results !== undefined && results.hits.length > 0 ? (
              <>
                {results.hits.map((hit) => (
                  <li key={hit.path}>
                    <button
                      type="button"
                      className="entry file"
                      onClick={() => openFile(hit.path)}
                    >
                      <span className="entry-name">{hit.name}</span>
                      <span className="entry-sub" title={hit.path}>
                        {hit.path}
                      </span>
                    </button>
                  </li>
                ))}
                {results.truncated && <li className="browse-hint">More results not shown.</li>}
              </>
            ) : (
              <li className="browse-hint">No files match.</li>
            )
          ) : dir === undefined ? (
            workspaceRoots.length === 0 ? (
              <li className="browse-hint">
                No repo locations yet — add one in Settings.
              </li>
            ) : (
              workspaceRoots.map((root) => (
                <li key={root}>
                  <button type="button" className="entry dir" onClick={() => openDir(root)}>
                    <span className="entry-icon" aria-hidden="true">
                      ▸
                    </span>
                    <span className="entry-name">{root}</span>
                  </button>
                </li>
              ))
            )
          ) : dir.entries.length === 0 ? (
            <li className="browse-hint">Empty folder.</li>
          ) : (
            dir.entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={`entry ${entry.kind}`}
                  onClick={() =>
                    entry.kind === "dir"
                      ? openDir(childPath(dir.path, entry.name))
                      : openFile(childPath(dir.path, entry.name))
                  }
                >
                  <span className="entry-icon" aria-hidden="true">
                    {entry.kind === "dir" ? "▸" : "·"}
                  </span>
                  <span className="entry-name">{entry.name}</span>
                </button>
              </li>
            ))
          )}
          {dir?.truncated === true && <li className="browse-hint">Folder truncated.</li>}
        </ul>
      </div>

      <div className="browse-pane browse-viewer">
        <FileViewer file={file} error={fileError} loading={fileLoading} />
      </div>
    </section>
  );
}
