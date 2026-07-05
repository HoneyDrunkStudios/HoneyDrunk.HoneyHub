import type { ReactElement } from "react";
import { basename } from "../../paths";
import { fileIcon } from "./fileIcons";

export interface EditorTab {
  /** The file's absolute path (the tab's identity). */
  path: string;
  /** True when the open buffer has unsaved edits (drives the dirty dot). */
  dirty: boolean;
}

export interface EditorTabsProps {
  /** Open files, in the order they were opened. */
  tabs: EditorTab[];
  /** The path of the tab whose editor is showing, or undefined. */
  activePath: string | undefined;
  /** Activate a tab (show its editor). */
  onActivate: (path: string) => void;
  /** Close a tab. */
  onClose: (path: string) => void;
}

/**
 * A VS Code-style tab strip above the editor. Each open file is a tab carrying its file-type
 * icon and name; the active tab is highlighted, a dirty tab shows a dot (which becomes a close
 * ✕ on hover), and every tab has an explicit close button. Clicking a tab activates it; the ✕
 * closes it. Purely presentational — the open-files list and active file live in
 * {@link RepositoriesView}.
 */
export default function EditorTabs({
  tabs,
  activePath,
  onActivate,
  onClose
}: Readonly<EditorTabsProps>): ReactElement | null {
  if (tabs.length === 0) {
    return null;
  }
  return (
    <div className="repos-tabs" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const name = basename(tab.path);
        const isActive = tab.path === activePath;
        return (
          <div
            key={tab.path}
            className={`repos-tab${isActive ? " is-active" : ""}${tab.dirty ? " is-dirty" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className="repos-tab-open"
              title={tab.path}
              onClick={() => onActivate(tab.path)}
              // Middle-click closes, matching editors people already use.
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab.path);
                }
              }}
            >
              <span className="repos-tab-icon" aria-hidden="true">
                {fileIcon(tab.path)}
              </span>
              <span className="repos-tab-name">{name}</span>
            </button>
            <button
              type="button"
              className="repos-tab-close"
              aria-label={`Close ${name}`}
              title={`Close ${name}`}
              onClick={() => onClose(tab.path)}
            >
              <span className="repos-tab-dot" aria-hidden="true" />
              <span className="repos-tab-x" aria-hidden="true">
                ✕
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
