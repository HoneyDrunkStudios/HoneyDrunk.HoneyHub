// Cockpit themes. Each theme is a set of CSS-variable overrides applied via a `data-theme`
// attribute on <html> (see styles.css `:root[data-theme="…"]`). The default "honey" theme is
// the base `:root` palette. Choice is persisted and applied before first paint (main.tsx) so
// there's no flash of the wrong theme.

export type ThemeId = "honey" | "midnight" | "matrix" | "light";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  hint: string;
}

export const THEMES: ThemeOption[] = [
  { id: "honey", label: "Honey Cyberpunk", hint: "Gold + neon on near-black (default)" },
  { id: "midnight", label: "Midnight", hint: "Cool cyan on deep blue-black" },
  { id: "matrix", label: "Matrix", hint: "Phosphor green on black" },
  { id: "light", label: "Daylight", hint: "Light background, dark text" }
];

const STORAGE_KEY = "honeyhub.theme.v1";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

export function loadTheme(): ThemeId {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isThemeId(raw) ? raw : "honey";
  } catch {
    return "honey";
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Best-effort.
  }
}

export function applyTheme(id: ThemeId): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = id;
  }
}
