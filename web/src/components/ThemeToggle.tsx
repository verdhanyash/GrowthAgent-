/**
 * web/src/components/ThemeToggle.tsx
 *
 * Header theme switcher:
 *  - "Dark Mode" (Pitch-black minimal fintech)
 *  - "Light Mode" (Crisp white canvas with bold Crimson Red primary accents)
 */
import React, { useEffect, useState } from "react";
import { applyTheme, getStoredTheme, type ThemeMode } from "../lib/theme.js";

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);

  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<ThemeMode>;
      if (customEvent.detail) {
        setTheme(customEvent.detail);
      }
    };
    window.addEventListener("growthagent:theme", handleThemeChange);
    return () => window.removeEventListener("growthagent:theme", handleThemeChange);
  }, []);

  const toggleTheme = () => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-white/[0.08] hover:text-white theme-toggle-btn"
      title={`Switch to ${theme === "dark" ? "Light" : "Dark"} mode`}
    >
      {theme === "dark" ? (
        <>
          <svg
            className="h-3.5 w-3.5 text-neutral-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <span className="font-mono text-[11px] text-neutral-200">Dark Mode</span>
        </>
      ) : (
        <>
          <svg
            className="h-3.5 w-3.5 text-red-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <span className="font-mono text-[11px] text-red-600 font-semibold">Light Mode</span>
        </>
      )}
    </button>
  );
}
