"use client";

import { type ReactNode, useEffect, useState } from "react";
import { DateInput } from "@/components/date-input";
import { Button, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./farm-rows.module.css";

export { styles as farmRowStyles };

/*
 * Farmer-friendly lists (#447, decisions 901 and 903). One line per record
 * ("16 · 3,057 kg DM/ha · 24 Oct · Milkers in"), at least 48px tall, that
 * opens to show the rest and its actions. Remove sits apart, under the
 * main actions, and asks first. Histories load from the server a page at a
 * time with From, To and paddock filters.
 */

export type FarmRow = {
  key: string;
  title: ReactNode;
  /** Shown on one line after the title, joined with " · ". Empty parts are left out. */
  parts: ReactNode[];
  /** What opens under the line: the rest of the record. */
  details?: ReactNode;
  /** The main actions (Record day out, Add cover). */
  actions?: ReactNode;
  /** Actions kept apart from the main ones (Remove). */
  more?: ReactNode;
  /** Instead of opening in place, the line is a button that does this (opens the paddock). */
  onOpen?: () => void;
};

function Line({ row, open }: { row: FarmRow; open: boolean }) {
  const parts = row.parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return (
    <>
      <span className={styles.title}>{row.title}</span>
      <span className={styles.parts}>
        {parts.map((part, index) => (
          <span key={index}>
            {index ? <span className={styles.muted}> · </span> : null}
            {part}
          </span>
        ))}
      </span>
      {open ? (
        <span className={styles.chevron} aria-hidden="true">
          ›
        </span>
      ) : null}
    </>
  );
}

export function FarmRowList({ rows, label }: { rows: FarmRow[]; label: string }) {
  return (
    <ul className={styles.list} aria-label={label}>
      {rows.map((row) => {
        const opens = Boolean(row.details || row.actions || row.more);
        return (
          <li key={row.key} className={styles.row}>
            {row.onOpen ? (
              <button type="button" className={`${styles.line} ${styles.button}`} onClick={row.onOpen}>
                <Line row={row} open />
              </button>
            ) : opens ? (
              <details>
                <summary className={styles.line}>
                  <Line row={row} open />
                </summary>
                <div className={styles.body}>
                  {row.details}
                  {row.actions ? <div className={styles.actions}>{row.actions}</div> : null}
                  {row.more ? <div className={styles.more}>{row.more}</div> : null}
                </div>
              </details>
            ) : (
              <div className={`${styles.line} ${styles.plain}`}>
                <Line row={row} open={false} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A bar for a value out of the largest, from one baseline (decision 600's chart blue). Decorative: the number is beside it. */
export function CoverBar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className={styles.bar} aria-hidden="true">
      <span className={styles.barFill} style={{ width: `${width}%` }} />
    </span>
  );
}

/** Remove, asking first. Kept away from the main actions. */
export function RemoveAction({ organisationId, path, what, onRemoved }: { organisationId: string; path: string; what: string; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking) {
    return (
      <button type="button" className={ui.linkButton} onClick={() => setAsking(true)}>
        Remove this {what}…
      </button>
    );
  }
  return (
    <>
      <span>Remove this {what}? It&apos;s kept in the history as removed.</span>
      <Button
        size="small"
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(path, { method: "DELETE", query: { organisationId } });
            onRemoved();
          } catch (caught) {
            setError(errorMessage(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        Remove
      </Button>
      <Button size="small" variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
        Keep
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </>
  );
}

export type HistoryFilterValues = {
  from: string;
  to: string;
  paddockId: string;
};

export const NO_FILTERS: HistoryFilterValues = {
  from: "",
  to: "",
  paddockId: "",
};

/**
 * Pages of a farm history from the server, newest first. `rowsKey` is the
 * array's name in the answer (`readings`, `grazings`, `supplements`). Changing
 * the filters (or `version`, after a change) starts again from the newest.
 */
export function useHistory<T>(path: string, rowsKey: string, organisationId: string, filters: HistoryFilterValues, version: number) {
  const [state, setState] = useState<{
    key: string;
    rows: T[];
    next: string | null;
    error: string | null;
    loading: boolean;
  }>({ key: "", rows: [], next: null, error: null, loading: true });
  const key = JSON.stringify([path, organisationId, filters, version]);
  const load = async (cursor: string | null, append: boolean) => {
    setState((current) => ({
      ...current,
      key,
      loading: true,
      error: null,
      rows: append ? current.rows : [],
    }));
    try {
      const answer = await api<Record<string, unknown> & { next: string | null }>(path, {
        query: {
          organisationId,
          from: filters.from,
          to: filters.to,
          paddockId: filters.paddockId,
          cursor,
        },
      });
      const rows = (answer[rowsKey] as T[]) ?? [];
      setState((current) =>
        current.key !== key
          ? current
          : {
              key,
              rows: append ? [...current.rows, ...rows] : rows,
              next: answer.next,
              error: null,
              loading: false,
            },
      );
    } catch (caught) {
      setState((current) => (current.key !== key ? current : { ...current, error: errorMessage(caught), loading: false }));
    }
  };
  useEffect(() => {
    void load(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers the path, filters and version.
  }, [key]);
  const current = state.key === key;
  return {
    rows: current ? state.rows : [],
    error: current ? state.error : null,
    loading: !current || state.loading,
    hasMore: current && state.next !== null,
    loadMore: () => (state.next ? void load(state.next, true) : undefined),
  };
}

export function HistoryFilters({ value, onChange, paddocks }: { value: HistoryFilterValues; onChange: (value: HistoryFilterValues) => void; paddocks?: Array<{ id: string; name: string }> }) {
  const active = Boolean(value.from || value.to || value.paddockId);
  return (
    <details className={styles.filterBox} open={active || undefined}>
      <summary className={styles.filterSummary}>{active ? "Filtered" : "Filter by date or paddock"}</summary>
      <div className={styles.filters} role="group" aria-label="Filter the history">
        <label>
          From
          <DateInput value={value.from} onChange={(event) => onChange({ ...value, from: event.target.value })} />
        </label>
        <label>
          To
          <DateInput value={value.to} onChange={(event) => onChange({ ...value, to: event.target.value })} />
        </label>
        {paddocks ? (
          <label>
            Paddock
            <select value={value.paddockId} onChange={(event) => onChange({ ...value, paddockId: event.target.value })}>
              <option value="">All paddocks</option>
              {paddocks.map((paddock) => (
                <option key={paddock.id} value={paddock.id}>
                  {paddock.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {value.from || value.to || value.paddockId ? (
          <Button variant="secondary" onClick={() => onChange(NO_FILTERS)}>
            Clear
          </Button>
        ) : null}
      </div>
    </details>
  );
}

export function HistoryFooter({ shown, hasMore, loading, error, onMore, noun }: { shown: number; hasMore: boolean; loading: boolean; error: string | null; onMore: () => void; noun: string }) {
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.footer}>
        <span className={ui.muted}>{loading && shown === 0 ? "Loading…" : `Showing ${shown.toLocaleString("en-NZ")} ${noun}${hasMore ? ", newest first" : ""}.`}</span>
        {hasMore ? (
          <Button variant="secondary" disabled={loading} onClick={onMore}>
            Show more
          </Button>
        ) : null}
      </div>
    </>
  );
}
