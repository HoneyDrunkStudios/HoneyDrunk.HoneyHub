import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  DirListing,
  FileContents,
  GitDiff,
  GitOverview,
  SearchResults
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { basename } from "../../paths";
import { resolveDefaultWorkspaceRoot } from "../../settingsModel";
import { diffStat, toDiffLines } from "../git/gitModel";
import { FileViewer } from "./FileViewer";

export interface BrowseViewProps {
  client: WireClient;
  /** The repo locations (allowlisted roots) the user picked — the starting points. */
  workspaceRoots: string[];
  active: boolean;
  /** The user's default workspace, used as the changed-files scope at the locations level. */
  defaultWorkspaceRoot?: string;
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


/** The list body while a filename search is in flight or has results. */
function renderSearchEntries(
  searching: boolean,
  results: SearchResults | undefined,
  openFile: (path: string) => void
): ReactNode {
  if (searching) {
    return <li className="browse-hint">Searching…</li>;
  }
  if (results === undefined || results.hits.length === 0) {
    return <li className="browse-hint">No files match.</li>;
  }
  return (
    <>
      {results.hits.map((hit) => (
        <li key={hit.path}>
          <button type="button" className="entry file" onClick={() => openFile(hit.path)}>
            <span className="entry-name">{hit.name}</span>
            <span className="entry-sub" title={hit.path}>
              {hit.path}
            </span>
          </button>
        </li>
      ))}
      {results.truncated && <li className="browse-hint">More results not shown.</li>}
    </>
  );
}

/** The top-level list of picked repo locations. */
function renderLocationEntries(
  workspaceRoots: string[],
  openDir: (path: string) => void
): ReactNode {
  if (workspaceRoots.length === 0) {
    return <li className="browse-hint">No repo locations yet. Add one in Settings.</li>;
  }
  return workspaceRoots.map((root) => (
    <li key={root}>
      <button type="button" className="entry dir" onClick={() => openDir(root)}>
        <span className="entry-icon" aria-hidden="true">
          ▸
        </span>
        <span className="entry-name">{root}</span>
      </button>
    </li>
  ));
}

/** The entries of the current (non-empty) directory listing. */
function renderDirEntries(
  dir: DirListing,
  openDir: (path: string) => void,
  openFile: (path: string) => void
): ReactNode {
  return dir.entries.map((entry) => (
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
  ));
}

/** Read-only repo/file browser (packet 09 §3): navigate the picked locations, search
    files by name, and view source (markdown rendered, code highlighted). All disk
    access goes through the bridge; reads are gated to the allowlisted roots. */
export function BrowseView({
  client,
  workspaceRoots,
  active,
  defaultWorkspaceRoot
}: Readonly<BrowseViewProps>) {
  // The current directory listing; undefined = the top-level list of repo locations.
  const [dir, setDir] = useState<DirListing | undefined>(undefined);
  const [file, setFile] = useState<FileContents | undefined>(undefined);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [fileLoading, setFileLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  // Git changes across the repos under the current location, surfaced as a separate panel
  // so it's easy to jump to what changed. Collapsible; refreshed live on fs_changed.
  const [overview, setOverview] = useState<GitOverview | undefined>(undefined);
  const [showChanges, setShowChanges] = useState(true);
  // The viewer pane shows either a file's contents or a changed file's diff.
  const [viewerMode, setViewerMode] = useState<"file" | "diff">("file");
  const [diff, setDiff] = useState<GitDiff | undefined>(undefined);

  // Path of the file currently being fetched, so a slower earlier read can't clobber
  // a newer one when its event finally arrives.
  const pendingFile = useRef<string | undefined>(undefined);
  // The (root, path) of the diff this view last requested, and the folder its changes panel
  // is scoped to — Git shares the same device-wide event bus, so we correlate to avoid each
  // surface clobbering the other's overview/diff.
  const pendingDiff = useRef<{ root: string; path: string } | undefined>(undefined);
  const changesFolderRef = useRef("");

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
      } else if (payload.kind === "git_overview") {
        if (payload.overview.root === changesFolderRef.current) {
          setOverview(payload.overview);
        }
      } else if (payload.kind === "git_diff") {
        const want = pendingDiff.current;
        if (payload.diff.root === want?.root && payload.diff.path === want?.path) {
          setDiff(payload.diff);
        }
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
    setViewerMode("file");
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

  // Open a changed file's diff in the viewer (the changes panel jumps straight to the diff
  // rather than the file contents).
  const openChangedDiff = (repoRoot: string, path: string) => {
    setViewerMode("diff");
    setDiff(undefined);
    pendingDiff.current = { root: repoRoot, path };
    void client.gitDiff(repoRoot, path).catch(() => undefined);
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

  // The git scope for the changed-files panel: the folder being browsed, or (at the
  // locations level) the default workspace.
  const changesFolder = dir?.path ?? resolveDefaultWorkspaceRoot(workspaceRoots, defaultWorkspaceRoot);
  changesFolderRef.current = changesFolder;
  const fetchChanges = useCallback(() => {
    if (changesFolder.length > 0) {
      void client.gitOverview(changesFolder).catch(() => undefined);
    }
  }, [client, changesFolder]);

  // While the Browse tab is open, keep it fresh: re-read on window focus and on a slow
  // fallback interval. The host's filesystem watcher (below) is the fast path; the poll is
  // a safety net for when the watcher is unavailable.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onFocus = () => {
      refresh();
      fetchChanges();
    };
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => {
      refresh();
      fetchChanges();
    }, 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, [active, refresh, fetchChanges]);

  // Fetch the changed-files panel on activation + whenever the browsed folder changes.
  useEffect(() => {
    if (active) {
      fetchChanges();
    }
  }, [active, fetchChanges]);

  // Live updates: the host pushes fs_changed when files change on disk (debounced); re-read
  // the current folder/file + the changes panel in response.
  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "fs_changed") {
        refresh();
        fetchChanges();
      }
    });
    return unsubscribe;
  }, [client, refresh, fetchChanges]);

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

  let entries: ReactNode;
  if (showingResults) {
    entries = renderSearchEntries(searching, results, openFile);
  } else if (dir === undefined) {
    entries = renderLocationEntries(workspaceRoots, openDir);
  } else if (dir.entries.length === 0) {
    entries = <li className="browse-hint">Empty folder.</li>;
  } else {
    entries = renderDirEntries(dir, openDir, openFile);
  }

  return (
    <section className="browse" aria-label="Browse">
      <div className="browse-pane browse-nav">
        <header className="browse-head">
          <div>
            <p className="eyebrow">Browse</p>
            <h2>{dir === undefined ? "Your repos" : basename(dir.path)}</h2>
          </div>
          <div className="browse-head-actions">
            <span className="live-dot" title="Live: updates when files change on disk" aria-hidden="true" />
            {dir !== undefined && (
              <button
                type="button"
                className="browse-refresh"
                onClick={() => {
                  refresh();
                  fetchChanges();
                }}
                aria-label="Refresh folder"
              >
                Refresh
              </button>
            )}
          </div>
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

        <BrowseChangesPanel
          overview={overview}
          showChanges={showChanges}
          onToggle={() => setShowChanges((value) => !value)}
          onOpenDiff={openChangedDiff}
        />

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
          {entries}
          {dir?.truncated === true && <li className="browse-hint">Folder truncated.</li>}
        </ul>
      </div>

      <div className="browse-pane browse-viewer">
        {viewerMode === "diff" ? (
          <BrowseDiffView diff={diff} />
        ) : (
          <FileViewer file={file} error={fileError} loading={fileLoading} />
        )}
      </div>
    </section>
  );
}

/** The CSS code-kind for a changed file: untracked, staged, or otherwise a dirty
    working-tree change. */
function changeCodeKind(entry: { untracked: boolean; staged: boolean }): string {
  if (entry.untracked) {
    return "untracked";
  }
  if (entry.staged) {
    return "staged";
  }
  return "dirty";
}

interface BrowseChangesPanelProps {
  overview: GitOverview | undefined;
  showChanges: boolean;
  onToggle: () => void;
  onOpenDiff: (repoRoot: string, path: string) => void;
}

/** The collapsible changed-files panel: the repos under the current scope that have
    working-tree changes, each file jumping straight to its diff. */
function BrowseChangesPanel({
  overview,
  showChanges,
  onToggle,
  onOpenDiff
}: Readonly<BrowseChangesPanelProps>): ReactNode {
  const changed = overview?.repos.filter((repo) => !repo.clean) ?? [];
  if (changed.length === 0) {
    return null;
  }
  const total = changed.reduce((sum, repo) => sum + repo.files.length, 0);
  return (
    <div className="browse-changes">
      <button
        type="button"
        className="browse-changes-head"
        aria-expanded={showChanges}
        onClick={onToggle}
      >
        <span className="browse-changes-caret" aria-hidden="true">
          {showChanges ? "▾" : "▸"}
        </span>
        <span>
          Changes <span className="browse-changes-count">{total}</span>
        </span>
      </button>
      {showChanges && (
        <ul className="browse-changes-list" aria-label="Changed files">
          {changed.map((repo) => (
            <li key={repo.root} className="browse-changes-repo">
              <p className="browse-changes-repo-name">
                {basename(repo.root)}
                {repo.branch !== undefined && (
                  <span className="browse-changes-branch">{repo.branch}</span>
                )}
              </p>
              <ul>
                {repo.files.map((entry) => {
                  const codeKind = changeCodeKind(entry);
                  return (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className="entry file"
                        onClick={() => onOpenDiff(repo.root, entry.path)}
                      >
                        <span className={`git-code code-${codeKind}`}>{entry.status}</span>
                        <span className="entry-name">{entry.path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The diff pane shown in Browse when a changed file is opened from the changes panel. */
function BrowseDiffView({ diff }: Readonly<{ diff: GitDiff | undefined }>): ReactNode {
  const stat = useMemo(() => (diff === undefined ? undefined : diffStat(diff.patch)), [diff]);
  const diffLines = useMemo(() => (diff === undefined ? [] : toDiffLines(diff.patch)), [diff]);
  const diffKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return diffLines.map((line) => {
      const base = `${line.kind}:${line.text}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { key: `${base}#${occurrence}`, line };
    });
  }, [diffLines]);

  if (diff === undefined) {
    return <p className="browse-hint">Loading diff…</p>;
  }
  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-path">{diff.path ?? "Changes"}</span>
        {stat !== undefined && (
          <span className="git-diff-stat">
            <span className="stat-add">+{stat.added}</span> <span className="stat-del">-{stat.removed}</span>
          </span>
        )}
      </div>
      {diff.patch.trim().length === 0 ? (
        <p className="browse-hint">No diff (the change may be untracked or staged only).</p>
      ) : (
        <figure className="diff-figure" aria-label="Diff">
          <pre className="diff-view">
            {diffKeys.map(({ key, line }) => (
              <span key={key} className={`diff-line diff-${line.kind}`}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </figure>
      )}
      {diff.truncated && <p className="git-truncated">Diff truncated (very large change).</p>}
    </div>
  );
}
