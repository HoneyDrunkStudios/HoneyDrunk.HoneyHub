import { useState } from "react";
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

  const selected = options.find(
    (option) => option.backend === selectedBackend && option.id === selectedId
  );
  const label = selectedId === customId ? "Custom model" : (selected?.label ?? selectedId);

  const choose = (backend: AgentBackend, id: string) => {
    onSelect(backend, id);
    setOpen(false);
  };

  return (
    <div className="model-menu">
      <button
        type="button"
        className="chip-button"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected !== undefined ? `${selected.label} · ${backendLabel(selected.backend)}` : label}
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
          <div className="model-popover" role="listbox" aria-label="Select model">
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
