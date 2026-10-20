"use client";

import { createContext, useContext } from "react";
import { BUILT_IN_THEMES, resolveTheme, themeCss, type ReportTheme } from "@/lib/charts/report-themes";

/**
 * A report's theme (#376, decision 668) as a style sheet scoped to one class.
 * Charts inside read the `--chart-*` variables from where they sit, and this
 * key tells them to read again when the theme changes.
 */
const ThemeKey = createContext("");

export function useReportThemeKey(): string {
  return useContext(ThemeKey);
}

/** The theme a report shows: a built-in one, its organisation's, or Tohyee's. */
export function reportTheme(choice: string | undefined, custom: ReportTheme | null | undefined): ReportTheme {
  return resolveTheme(choice, custom ?? null);
}

export function isTohyee(theme: ReportTheme): boolean {
  return theme === BUILT_IN_THEMES.tohyee;
}

/**
 * The style sheet and the key for a theme. Everything in the CSS was checked
 * when the theme was saved (hex colours, whole numbers, fonts from a list),
 * and is checked again by `themeCss`, so it can be put on the page as is.
 */
export function ReportThemeStyle({ theme, scope, children }: { theme: ReportTheme; scope: string; children: React.ReactNode }) {
  const css = themeCss(theme, scope);
  return (
    <ThemeKey.Provider value={css}>
      {css ? <style>{css}</style> : null}
      {children}
    </ThemeKey.Provider>
  );
}
