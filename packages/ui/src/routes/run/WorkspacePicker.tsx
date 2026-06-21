import { useState } from "react";
import type { WireClient } from "../../wire/client";
import { basename } from "../../paths";
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
  /** The user's default workspace (pre-selected across the app), if any. */
  defaultRoot?: string;
  /** Set a root as the default. Omitted = the default-marking affordance is hidden. */
  onSetDefault?: (root: string) => void;
}

/** A non-typable workspace chip: clicking it opens a panel to pick "no workspace", a
    configured root, or browse for a folder / `.code-workspace` file. */
export function WorkspacePicker({
  client,
  roots,
  value,
  onSelect,
  onAddRoots,
  defaultRoot,
  onSetDefault
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
          <button
            type="button"
            className="ws-backdrop"
            aria-label="Close workspace picker"
            onClick={() => setOpen(false)}
          />
          <dialog className="ws-popover" aria-label="Select workspace" open>
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
                {roots.map((root) => {
                  const isDefault = root === defaultRoot;
                  return (
                    <li key={root} className="ws-root-row">
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
                        {isDefault && <span className="ws-default-tag">default</span>}
                        <span className="ws-option-sub">{root}</span>
                      </button>
                      {onSetDefault !== undefined && (
                        <button
                          type="button"
                          className={`ws-default-star ${isDefault ? "is-default" : ""}`}
                          aria-label={isDefault ? `${basename(root)} is the default` : `Set ${basename(root)} as default`}
                          aria-pressed={isDefault}
                          title={isDefault ? "Default workspace" : "Set as default"}
                          onClick={() => onSetDefault(root)}
                        >
                          {isDefault ? "★" : "☆"}
                        </button>
                      )}
                    </li>
                  );
                })}
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
          </dialog>
        </>
      )}
    </div>
  );
}
