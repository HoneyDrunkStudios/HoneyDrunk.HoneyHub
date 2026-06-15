import { useEffect, useState } from "react";
import type { DirListing } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";

export interface FolderBrowserProps {
  client: WireClient;
  /** Add one or more repo locations: a single picked folder, or all the folders a
      selected `.code-workspace` file resolves to. */
  onAddRoots: (paths: string[]) => void;
}

function childPath(parent: string, name: string): string {
  if (parent.length === 0) {
    return name; // top-level entries are absolute drive/roots
  }
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function isWorkspaceFile(name: string): boolean {
  return name.toLowerCase().endsWith(".code-workspace");
}

/** A read-only navigator for picking a repo location — folders to drill into, plus
    `.code-workspace` files you can select to add all the repos they reference. Backed
    by the bridge's `browse_dir` + `resolve_workspace_file`. */
export function FolderBrowser({ client, onAddRoots }: Readonly<FolderBrowserProps>) {
  const [dir, setDir] = useState<DirListing | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const payload = event.payload;
      if (payload.kind === "dir_listing") {
        setDir(payload.listing);
      } else if (payload.kind === "workspace_folders") {
        // A selected .code-workspace resolved → add its repo folders.
        if (payload.folders.folders.length > 0) {
          onAddRoots(payload.folders.folders);
        }
      }
    });
    void client.browseDir(undefined).catch(() => undefined);
    return unsubscribe;
  }, [client, onAddRoots]);

  const open = (path: string) => {
    void client.browseDir(path.length === 0 ? undefined : path).catch(() => undefined);
  };

  const atTop = dir === undefined || dir.path.length === 0;
  const entries = (dir?.entries ?? []).filter(
    (entry) => entry.kind === "dir" || isWorkspaceFile(entry.name)
  );

  return (
    <div className="folder-browser">
      <div className="folder-bar">
        <button
          type="button"
          className="crumb up"
          onClick={() => open(dir?.parent ?? "")}
          disabled={atTop}
        >
          Up
        </button>
        <span className="folder-path" title={dir?.path ?? ""}>
          {atTop ? "This PC" : dir?.path}
        </span>
        <button
          type="button"
          className="folder-use"
          onClick={() => dir !== undefined && onAddRoots([dir.path])}
          disabled={atTop}
        >
          Use this folder
        </button>
      </div>
      <ul className="folder-list" aria-label="Folders and workspaces">
        {entries.length === 0 ? (
          <li className="browse-hint">No subfolders or workspace files.</li>
        ) : (
          entries.map((entry) => {
            const workspace = entry.kind === "file";
            const path = childPath(dir?.path ?? "", entry.name);
            return (
              <li key={entry.name}>
                <button
                  type="button"
                  className={`entry ${workspace ? "workspace" : "dir"}`}
                  onClick={() =>
                    workspace
                      ? void client.resolveWorkspaceFile(path).catch(() => undefined)
                      : open(path)
                  }
                  title={workspace ? "Add all repos in this workspace file" : undefined}
                >
                  <span className="entry-icon" aria-hidden="true">
                    {workspace ? "▦" : "▸"}
                  </span>
                  <span className="entry-name">{entry.name}</span>
                  {workspace && <span className="entry-tag">workspace</span>}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
