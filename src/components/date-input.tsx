"use client";

import { type InputHTMLAttributes, useRef, useState } from "react";
import { isIsoDate, parseDateEntry, showDateEntry } from "@/lib/date-entry";
import { todayInBrowser } from "@/lib/format";

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "defaultValue"> & {
  /** An ISO date (YYYY-MM-DD), or "". */
  value: string;
  /** Called with an ISO date or "", shaped like an input's change event so it drops in for `<input type="date">`. */
  onChange: (event: { target: { value: string } }) => void;
  /** What +14 and +20m count from (a due date's document date); today when not given. */
  base?: string | null;
};

const HELP = "Type a date like 14/10/2026, 1410, +14 (days) or +20m (20th of next month)";

/**
 * A date field for fast keyboard entry (#258): type it day first or in
 * shorthand, and it's read when you leave the field or press Enter. The
 * calendar button opens the browser's own date picker.
 */
export function DateInput({ value, onChange, base, onBlur, onKeyDown, style, className, disabled, required, min, max, ...rest }: DateInputProps) {
  const [text, setText] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const shown = text ?? showDateEntry(value);
  const invalid = text !== null && text.trim() !== "" && parseDateEntry(text, todayInBrowser(), base) === null;
  const commit = () => {
    if (text === null) return;
    if (text.trim() === "") {
      setText(null);
      if (value !== "") onChange({ target: { value: "" } });
      return;
    }
    const parsed = parseDateEntry(text, todayInBrowser(), base);
    if (!parsed) return;
    setText(null);
    if (parsed !== value) onChange({ target: { value: parsed } });
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "stretch", gap: 4, maxWidth: "100%", ...style }} className={className}>
      <input
        {...rest}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={rest.placeholder ?? "dd/mm/yyyy"}
        title={HELP}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        required={required}
        value={shown}
        size={11}
        style={{ minWidth: 0, flex: "1 1 auto", ...(invalid ? { borderColor: "var(--danger, #b42318)" } : {}) }}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => {
          commit();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape" && text !== null) {
            setText(null);
            event.preventDefault();
          }
          onKeyDown?.(event);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Choose a date"
        title="Choose a date"
        disabled={disabled}
        style={{ position: "relative", padding: "0 8px", borderRadius: 8, border: "1px solid var(--border, #c4ccd8)", background: "var(--surface, #fff)", color: "inherit", cursor: "pointer" }}
        onClick={() => {
          const input = picker.current;
          if (!input) return;
          try {
            input.showPicker();
          } catch {
            input.focus();
          }
        }}
      >
        <span aria-hidden="true">📅</span>
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={isIsoDate(value) ? value : ""}
          min={min}
          max={max}
          onChange={(event) => {
            setText(null);
            onChange({ target: { value: event.target.value } });
          }}
          style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", pointerEvents: "none", border: 0, padding: 0 }}
        />
      </button>
    </span>
  );
}
