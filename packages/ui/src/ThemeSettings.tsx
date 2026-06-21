import type { ReactElement } from "react";
import { THEMES, type ThemeId } from "./theme";

export interface ThemeSettingsProps {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
}

/** Theme picker: swatch + label per theme, applied live. */
export function ThemeSettings({ theme, onChange }: Readonly<ThemeSettingsProps>): ReactElement {
  return (
    <section className="theme-settings" aria-label="Theme">
      <h3>Theme</h3>
      <ul className="theme-options" aria-label="Themes">
        {THEMES.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              className={`theme-option ${theme === option.id ? "is-active" : ""}`}
              aria-pressed={theme === option.id}
              onClick={() => onChange(option.id)}
            >
              <span className={`theme-swatch swatch-${option.id}`} aria-hidden="true" />
              <span className="theme-option-text">
                <span className="theme-option-label">{option.label}</span>
                <span className="theme-option-hint">{option.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
