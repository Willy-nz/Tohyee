"use client";

import { type ReactNode, useRef } from "react";
import styles from "./store-setup.module.css";

/**
 * Big tappable choices side by side (a radio group), for the first question
 * of a guided setup (decision 1258): "Which shop do you use?", "How are
 * documents emailed?". A choice hidden in a dropdown is easy to miss; these
 * show every option with a line on what it's for. Arrow keys move between
 * them, as in any radio group.
 */
export function ChoiceTiles<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; title: string; text: ReactNode; icon?: ReactNode }>;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, step: number) => {
    const to = (from + step + options.length) % options.length;
    onChange(options[to].value);
    refs.current[to]?.focus();
  };
  return (
    <div className={styles.shops} role="radiogroup" aria-label={label} data-count={options.length}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={styles.shop}
          data-icon={option.icon ? "yes" : "no"}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          }}
        >
          {option.icon ?? null}
          <span>
            <span className={styles.shopName}>{option.title}</span>
            <span className={styles.shopText}>{option.text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
