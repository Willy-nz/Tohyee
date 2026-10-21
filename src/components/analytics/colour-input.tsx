"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui";
import styles from "./chart-format-panel.module.css";

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Any colour, as a picker and a hex box, with "Reset" back to the theme's
 * (#376). An unfinished hex isn't passed on until it's a whole colour.
 */
export function ColourInput({
  label,
  value,
  placeholder,
  onChange,
  resetLabel = "Reset to theme",
  emptyText = "Theme",
}: {
  label: string;
  value: string | undefined;
  /** The colour shown when none is chosen (the theme's), for the swatch. */
  placeholder?: string;
  onChange: (value: string | undefined) => void;
  resetLabel?: string;
  /** What the hex box says when no colour is chosen. */
  emptyText?: string;
}) {
  const id = useId();
  // What's being typed; the saved colour shows again once the box loses focus.
  const [draft, setDraft] = useState<string | null>(null);
  // With no colour chosen the picker shows the theme's (or white), never a misleading black.
  const shown = value ?? placeholder ?? "#ffffff";
  return (
    <div className={styles.colourInput}>
      <label htmlFor={id} className={styles.colourLabel}>{label}</label>
      <div className={styles.colourControls}>
        <input type="color" aria-label={`${label} picker`} value={HEX.test(shown) ? shown.toLowerCase() : "#ffffff"} onChange={(event) => onChange(event.target.value)} />
        <input
          id={id}
          className={styles.hexBox}
          value={draft ?? value ?? ""}
          onBlur={() => setDraft(null)}
          placeholder={emptyText}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const text = event.target.value.trim();
            setDraft(event.target.value);
            if (text === "") onChange(undefined);
            else if (HEX.test(text)) onChange(text.toLowerCase());
          }}
        />
        <Button size="small" variant="secondary" disabled={!value} onClick={() => onChange(undefined)} aria-label={`${resetLabel}: ${label}`}>
          Reset
        </Button>
      </div>
    </div>
  );
}
