"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Destination, searchDestinations } from "@/components/navigation";
import { useWorkspace } from "@/components/workspace";
import type { SearchFilter, SearchGroup, SearchKind, SearchRecord } from "@/lib/search/types";

const KIND_LABELS: Partial<Record<SearchKind, string>> = {
  contact: "Contact",
  invoice: "Invoice",
  sales_credit_note: "Credit note",
  quote: "Quote",
  sales_order: "Sales order",
  bill: "Bill",
  supplier_credit_note: "Supplier credit",
  purchase_order: "Purchase order",
  customer_payment: "Payment in",
  supplier_payment: "Payment out",
  bank_statement_line: "Bank line",
  journal: "Journal",
  item: "Item",
  account: "Account",
  fixed_asset: "Fixed asset",
  crm_company: "Company",
  crm_person: "Person",
  crm_opportunity: "Opportunity",
  dashboard: "Dashboard",
};
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
  const { current } = useWorkspace();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [active, setActive] = useState(0);
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentTick, setRecentTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const trimmed = query.trim();
  const storageKey = useMemo(() => `tohyee.search.recent.${current?.id ?? "none"}`, [current?.id]);
  const goTo = useMemo(() => searchDestinations(items, trimmed), [items, trimmed]);
  const recent = useMemo(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is SearchRecord => Boolean(entry?.href && entry?.title && entry?.kind)).slice(0, 12);
    } catch {
      return [];
    }
  }, [recentTick, storageKey]);
  const records = useMemo(
    () => (trimmed.length === 0 ? recent : trimmed.length < 2 ? [] : groups.flatMap((group) => group.records)),
    [groups, recent, trimmed.length],
  );
  const results = useMemo(
    () => [
      ...records.map((record) => ({ type: "record" as const, record })),
      ...goTo.map((destination) => ({ type: "goto" as const, destination })),
    ],
    [goTo, records],
  );
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const filterChoices: Array<{ key: SearchFilter; label: string }> = [
    { key: "all", label: "All" },
    { key: "contacts", label: "Contacts" },
    { key: "sales", label: "Sales" },
    { key: "purchases", label: "Purchases" },
    { key: "banking", label: "Banking" },
    { key: "accounts", label: "Accounts" },
    { key: "crm", label: "CRM" },
  ];

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

  // Only the newest search's answer is shown; a slower, older one is ignored.
  const latest = useRef(0);
  useEffect(() => {
    if (!current) return;
    if (trimmed.length < 2) return;
    const ticket = ++latest.current;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch(
        `/api/search?organisationId=${encodeURIComponent(current.id)}&q=${encodeURIComponent(trimmed)}&kind=${encodeURIComponent(filter)}`,
        { signal: abort.signal },
      )
        .then(async (response) => {
          if (!response.ok || ticket !== latest.current) return;
          const payload = (await response.json()) as { groups?: SearchGroup[] };
          if (ticket === latest.current) setGroups(Array.isArray(payload.groups) ? payload.groups : []);
        })
        .catch(() => undefined)
        .finally(() => {
          if (ticket === latest.current) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [current, filter, trimmed]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function remember(record: SearchRecord) {
    const next = [record, ...recent.filter((entry) => !(entry.kind === record.kind && entry.href === record.href))].slice(0, 12);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      setRecentTick((value) => value + 1);
    } catch {
      // Ignore private mode failures.
    }
  }

  function go(
    result:
      | { type: "record"; record: SearchRecord }
      | { type: "goto"; destination: Destination }
      | undefined,
  ) {
    if (!result) return;
    const href = result.type === "record" ? result.record.href : result.destination.href;
    if (result.type === "record") remember(result.record);
    onClose();
    router.push(href);
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
            aria-label="Search records, pages and actions"
            placeholder="Search records, pages and actions…"
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
        <div className={styles.chips}>
          {filterChoices.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`${styles.chip} ${chip.key === filter ? styles.chipActive : ""}`}
              onClick={() => {
                setFilter(chip.key);
                setActive(0);
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <ul id={listId} ref={list} role="listbox" aria-label="Pages and actions" className={styles.list}>
          {records.length > 0 ? <li className={styles.section}>Records</li> : null}
          {records.map((record, index) => (
            <li key={`${record.kind}|${record.href}`}>
              <div
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
                onMouseMove={() => {
                  if (index !== activeIndex) setActive(index);
                }}
                onClick={() => go({ type: "record", record })}
              >
                <span className={styles.kind}>{KIND_LABELS[record.kind] ?? record.kind}</span>
                <span className={styles.recordText}>
                  <span className={styles.label}>{record.title}</span>
                  <span className={styles.subtitle}>{record.subtitle}</span>
                </span>
                {record.status ? <span className={styles.group}>{record.status}</span> : null}
              </div>
            </li>
          ))}
          {goTo.length > 0 ? <li className={styles.section}>Go to</li> : null}
          {goTo.map((destination, offset) => {
            const index = records.length + offset;
            return (
              <li key={`${destination.group}|${destination.href}|${destination.label}`}>
                <div
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
                  onMouseMove={() => {
                    if (index !== activeIndex) setActive(index);
                  }}
                  onClick={() => go({ type: "goto", destination })}
                >
                  <span className={styles.label}>{destination.label}</span>
                  <span className={styles.group}>{destination.group}</span>
                </div>
              </li>
            );
          })}
        </ul>
        {loading && trimmed.length > 0 ? <p className={styles.empty}>Searching…</p> : null}
        {results.length === 0 && !loading ? (
          <p className={styles.empty}>
            {trimmed.length === 0 ? "No recent records yet. Open a record and it will appear here." : `Nothing matches “${query}”. Try another word.`}
          </p>
        ) : null}
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
