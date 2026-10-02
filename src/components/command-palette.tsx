"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Destination, searchDestinations } from "@/components/navigation";
import styles from "./command-palette.module.css";

/**
 * Ctrl+K / Cmd+K: type part of a page's name (or its menu) and press Enter
 * to go there. Built from the same menus as the top bar, so it only offers
 * what the person can see there.
 */
export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: Destination[] }) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} items={items} />;
}

function PaletteDialog({ onClose, items }: { onClose: () => void; items: Destination[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const results = useMemo(() => searchDestinations(items, query), [items, query]);
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  // Focus the search box; give focus back to whatever had it when closing.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function go(destination: Destination | undefined) {
    if (!destination) return;
    onClose();
    router.push(destination.href);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(results.length === 0 ? 0 : (activeIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(results.length === 0 ? 0 : (activeIndex - 1 + results.length) % results.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      // Keep focus in the search box while the dialog is open.
      event.preventDefault();
    }
  }

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Go to a page" onKeyDown={onKeyDown}>
        <div className={styles.searchRow}>
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden focusable="false" className={styles.searchIcon}>
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? optionId(activeIndex) : undefined}
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <ul id={listId} ref={list} role="listbox" aria-label="Pages and actions" className={styles.list}>
          {results.map((item, index) => (
            <li
              key={`${item.group}|${item.href}|${item.label}`}
              id={optionId(index)}
              data-index={index}
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
              onMouseMove={() => {
                if (index !== activeIndex) setActive(index);
              }}
              onClick={() => go(item)}
            >
              <span className={styles.label}>{item.label}</span>
              <span className={styles.group}>{item.group}</span>
            </li>
          ))}
        </ul>
        {results.length === 0 ? <p className={styles.empty}>Nothing matches “{query}”. Try another word.</p> : null}
        <div className={styles.footer} aria-hidden>
          <span>
            <kbd className={styles.kbd}>↑</kbd> <kbd className={styles.kbd}>↓</kbd> to move
          </span>
          <span>
            <kbd className={styles.kbd}>Enter</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
