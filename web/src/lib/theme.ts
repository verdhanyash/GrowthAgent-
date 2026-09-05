/**
 * web/src/lib/theme.ts
 *
 * Theme management for GrowthAgent.
 * Supports:
 *  - 'dark' (Default): Minimal pitch-black fintech theme
 *  - 'light': Crisp modern light theme with bold Crimson Red primary accents
 */

export type ThemeMode = "dark" | "light";

const THEME_KEY = "growthagent.theme";

export function getStoredTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* fallback to default */
  }
  return "dark";
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "light") {
    root.classList.add("theme-light");
    root.classList.remove("dark");
  } else {
    root.classList.remove("theme-light");
    root.classList.add("dark");
  }
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("growthagent:theme", { detail: mode }));
  }
}
