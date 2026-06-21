import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentBackend } from "@honeydrunk/honeyhub-types";
import { backendLabel } from "../../backends";

export interface ModelOption {
  backend: AgentBackend;
  id: string;
  label: string;
}

export interface ModelMenuProps {
  /** Every selectable model across all routable backends — selecting one routes to
      its backend, so there is no separate provider picker. */
  options: ModelOption[];
  /** The currently selected backend + model id (`customId` when free-text custom). */
  selectedBackend: AgentBackend;
  selectedId: string;
  /** Sentinel id for the free-text "Custom model…" entry. */
  customId: string;
  /** The router's suggested backend, tagged in the list. */
  suggestedBackend?: AgentBackend;
  /** Select a concrete model (routes to `backend`) or the custom entry (`customId`). */
  onSelect: (backend: AgentBackend, id: string) => void;
}

/** A custom (non-native) model dropdown: one unified, themed list of models that
    auto-routes to the right backend. Mirrors the workspace-chip popover so the active
    option carries a cyan outline instead of the OS's grey highlight. */
export function ModelMenu({
  options,
  selectedBackend,
  selectedId,
  customId,
  suggestedBackend,
  onSelect
}: Readonly<ModelMenuProps>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find(
    (option) => option.backend === selectedBackend && option.id === selectedId
  );
  const label = selectedId === customId ? "Custom model" : (selected?.label ?? selectedId);

  // When the listbox opens, move focus to the active option (or the first) so keyboard users
  // land inside it; Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) {
      return;
    }
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const active = list.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]');
    const first = list.querySelector<HTMLButtonElement>('[role="option"]');
    (active ?? first)?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (backend: AgentBackend, id: string) => {
    onSelect(backend, id);
    close();
  };

  // Listbox keyboard pattern: Escape closes, Arrow/Home/End roves focus across the options
  // (Enter/Space select via each option's native button click).
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (items.length === 0) {
      return;
    }
    const current = items.findIndex((item) => item === document.activeElement);
    let next: number;
    if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    } else if (event.key === "ArrowDown") {
      next = current < 0 ? 0 : (current + 1) % items.length;
    } else {
      next = current <= 0 ? items.length - 1 : current - 1;
    }
    items[next]?.focus();
  };

  return (
    <div className="model-menu">
      <button
        ref={triggerRef}
        type="button"
        className="chip-button"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected === undefined ? label : `${selected.label} · ${backendLabel(selected.backend)}`}
        onClick={() => setOpen((prev) => !prev)}
      >
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
            aria-label="Close model picker"
            onClick={() => setOpen(false)}
          />
          <div
            ref={listRef}
            className="model-popover"
            role="listbox"
            aria-label="Select model"
            onKeyDown={onListKeyDown}
          >
            {options.map((option) => {
              const active = option.backend === selectedBackend && option.id === selectedId;
              return (
                <button
                  type="button"
                  key={`${option.backend}:${option.id}`}
                  className={`model-option${active ? " is-active" : ""}`}
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(option.backend, option.id)}
                >
                  <span className="model-option-label">{option.label}</span>
                  <span className="model-option-sub">
                    {backendLabel(option.backend)}
                    {option.backend === suggestedBackend ? " · suggested" : ""}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`model-option${selectedId === customId ? " is-active" : ""}`}
              role="option"
              aria-selected={selectedId === customId}
              onClick={() => choose(selectedBackend, customId)}
            >
              <span className="model-option-label">Custom model…</span>
              <span className="model-option-sub">type an exact id</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
