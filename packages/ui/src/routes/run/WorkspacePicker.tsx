import { useState } from "react";
import type { WireClient } from "../../wire/client";
import { FolderBrowser } from "../onboarding/FolderBrowser";

export interface WorkspacePickerProps {
  client: WireClient;
  /** Configured repo locations to quick-pick from. */
  roots: string[];
  /** The currently selected workspace ("" = no workspace / just chat). */
  value: string;
  /** Select a workspace for this run. */
  onSelect: (path: string) => void;
  /** Persist newly-browsed locations (folder or resolved .code-workspace repos). */
  onAddRoots: (paths: string[]) => void;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

/** A non-typable workspace chip: clicking it opens a panel to pick "no workspace", a
    configured root, or browse for a folder / `.code-workspace` file. */
export function WorkspacePicker({
  client,
  roots,
  value,
  onSelect,
  onAddRoots
}: Readonly<WorkspacePickerProps>) {
  const [open, setOpen] = useState(false);

  const label = value.length === 0 ? "No workspace" : basename(value);

  return (
    <div className="ws-picker">
      <button
        type="button"
        className="chip-button"
        aria-label="Workspace"
        title={value.length === 0 ? "No workspace (just chat)" : value}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="chip-icon" aria-hidden="true">
          ▤
        </span>
        <span className="chip-text">{label}</span>
        <span className="chip-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className="ws-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-popover" role="dialog" aria-label="Select workspace">
            <button
              type="button"
              className="ws-option"
              onClick={() => {
                onSelect("");
                setOpen(false);
              }}
            >
              No workspace <span className="ws-option-sub">just chat</span>
            </button>
            {roots.length > 0 && (
              <ul className="ws-roots" aria-label="Configured locations">
                {roots.map((root) => (
                  <li key={root}>
                    <button
                      type="button"
                      className="ws-option"
                      title={root}
                      onClick={() => {
                        onSelect(root);
                        setOpen(false);
                      }}
                    >
                      {basename(root)}
                      <span className="ws-option-sub">{root}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="ws-browse-label">Browse for a folder or .code-workspace</p>
            <FolderBrowser
              client={client}
              onAddRoots={(paths) => {
                onAddRoots(paths);
                if (paths[0] !== undefined) {
                  onSelect(paths[0]);
                }
                setOpen(false);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
