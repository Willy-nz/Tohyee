"use client";

import { useRef, type ReactNode } from "react";
import styles from "./panel-tabs.module.css";

/**
 * Tabs for a panel (#387, decision 750): the WAI-ARIA tabs pattern, so
 * the arrow keys, Home and End move between them and Tab goes into the
 * chosen one. Every panel stays in the page (hidden), so nothing typed in
 * one is lost by looking at another.
 */
export function PanelTabs<T extends string>({
  id,
  label,
  tabs,
  chosen,
  onChoose,
  panels,
}: {
  id: string;
  label: string;
  tabs: Array<{ value: T; label: string; note?: string }>;
  chosen: T;
  onChoose: (value: T) => void;
  panels: Record<T, ReactNode>;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focus = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    onChoose(next.value);
    list.current?.querySelector<HTMLButtonElement>(`#${id}-tab-${next.value}`)?.focus();
  };
  return (
    <>
      <div ref={list} role="tablist" aria-label={label} className={styles.tabs}>
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${id}-tab-${tab.value}`}
            aria-selected={chosen === tab.value}
            aria-controls={`${id}-panel-${tab.value}`}
            tabIndex={chosen === tab.value ? 0 : -1}
            className={styles.tab}
            onClick={() => onChoose(tab.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") focus(index + 1);
              else if (event.key === "ArrowLeft") focus(index - 1);
              else if (event.key === "Home") focus(0);
              else if (event.key === "End") focus(tabs.length - 1);
              else return;
              event.preventDefault();
            }}
          >
            {tab.label}
            {tab.note ? <span className={styles.note}> {tab.note}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.value} role="tabpanel" id={`${id}-panel-${tab.value}`} aria-labelledby={`${id}-tab-${tab.value}`} hidden={chosen !== tab.value} className={styles.panel}>
          {panels[tab.value]}
        </div>
      ))}
    </>
  );
}
