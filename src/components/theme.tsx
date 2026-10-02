"use client";

import { useId, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-script";
import styles from "./theme.module.css";

export type ThemeChoice = "system" | "light" | "dark";

const CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Saves the choice and applies it straight away (System removes data-theme). */
export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage blocked: the choice applies to this page only.
  }
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  listeners.forEach((listener) => listener());
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => "system");
}

/** System / Light / Dark, as a small segmented control (radio buttons underneath). */
export function ThemeSwitch() {
  const choice = useThemeChoice();
  const name = useId();
  return (
    <fieldset className={styles.switch}>
      <legend className={styles.legend}>Theme</legend>
      <div className={styles.options}>
        {CHOICES.map((option) => (
          <label key={option.value} className={`${styles.option} ${choice === option.value ? styles.optionActive : ""}`}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={choice === option.value}
              onChange={() => setThemeChoice(option.value)}
              className={styles.radio}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
