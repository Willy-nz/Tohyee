"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useApiData } from "@/components/hooks";
import { api, errorMessage } from "@/lib/client/api";
import { moveTile, toggleTile } from "@/lib/dashboard/tiles";
import { ui } from "@/components/ui";
import styles from "./page-dashboard.module.css";

type Preference = { hidden: boolean; tiles: string[]; customised?: boolean; kind?: string; defaultTiles?: string[] };

export function useDashboardPreferences({
  organisationId,
  page,
  defaultTiles,
}: {
  organisationId: string;
  page: string;
  defaultTiles: readonly string[];
}) {
  const loaded = useApiData<Preference>("/api/dashboard-preferences", { organisationId, page });
  const [override, setOverride] = useState<Preference | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useMemo<Preference>(
    () =>
      override ??
      (loaded.data
        ? { ...loaded.data, tiles: loaded.data.tiles.length > 0 ? loaded.data.tiles : [...defaultTiles] }
        : { hidden: false, tiles: [...defaultTiles] }),
    [override, loaded.data, defaultTiles],
  );

  async function save(next: Preference) {
    setOverride({ ...state, ...next, customised: true });
    setSaving(true);
    setError(null);
    try {
      const saved = await api<Preference>("/api/dashboard-preferences", { method: "PUT", body: { organisationId, page, hidden: next.hidden, tiles: next.tiles } });
      setOverride(saved);
    } catch (caught) {
      setError(errorMessage(caught));
      setOverride(null);
      loaded.reload();
    } finally {
      setSaving(false);
    }
  }

  /** Back to the starting cards Tohyee picks for this person (decision 660). */
  async function reset() {
    setSaving(true);
    setError(null);
    try {
      setOverride(await api<Preference>("/api/dashboard-preferences", { method: "DELETE", query: { organisationId, page } }));
    } catch (caught) {
      setError(errorMessage(caught));
      setOverride(null);
      loaded.reload();
    } finally {
      setSaving(false);
    }
  }

  return {
    hidden: state.hidden,
    tiles: state.tiles,
    /** Whether the person has saved their own choice (it always wins over the starting cards). */
    customised: state.customised ?? false,
    /** The starting cards for this person, for Customise to say so. */
    startingTiles: state.defaultTiles ?? [...defaultTiles],
    /** Until the person's own tiles (or their starting ones) have loaded. */
    ready: override !== null || loaded.data !== null || loaded.error !== null,
    loading: loaded.loading,
    saving,
    error: error ?? loaded.error,
    setHidden: (hidden: boolean) => save({ hidden, tiles: state.tiles }),
    setTiles: (tiles: string[]) => save({ hidden: state.hidden, tiles }),
    reset,
  };
}

export function PageDashboardFrame({
  hidden,
  onToggleHidden,
  children,
  customise,
}: {
  hidden: boolean;
  onToggleHidden: () => void;
  children: ReactNode;
  customise?: ReactNode;
}) {
  const [showCustomise, setShowCustomise] = useState(false);
  const heading = useMemo(
    () =>
      hidden ? (
        <div className={styles.hiddenRow}>
          Dashboard hidden on this page ·{" "}
          <button type="button" className={styles.linkButton} onClick={onToggleHidden}>
            Show dashboard
          </button>
        </div>
      ) : null,
    [hidden, onToggleHidden],
  );
  if (hidden) return <div className={styles.frame}>{heading}</div>;
  return (
    <section className={styles.frame} aria-label="Dashboard">
      <div className={styles.top}>
        <button type="button" className={styles.linkButton} onClick={() => setShowCustomise((value) => !value)}>
          {showCustomise ? "Close customise" : "Customise"}
        </button>
        <span aria-hidden style={{ margin: "0 7px", color: "var(--text-muted)" }}>
          ·
        </span>
        <button type="button" className={styles.linkButton} onClick={onToggleHidden}>
          Hide
        </button>
      </div>
      {showCustomise ? <div className={styles.customise}>{customise}</div> : null}
      {children}
    </section>
  );
}

export function DashboardTileSlots<T extends string>({
  tiles,
  options,
  onChange,
}: {
  tiles: T[];
  options: Array<{ id: T; label: string }>;
  onChange: (tiles: T[]) => void;
}) {
  return (
    <div className={styles.slots}>
      {tiles.map((tile, index) => (
        <div key={`${tile}-${index}`} className={styles.slot}>
          <label>
            Tile {index + 1}
            <select
              value={tile}
              onChange={(event) => {
                const next = [...tiles];
                next[index] = event.target.value as T;
                onChange(Array.from(new Set(next)).concat(tiles.filter((item) => !next.includes(item))).slice(0, 4) as T[]);
              }}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}
    </div>
  );
}

/**
 * Customise for a page of cards (the farm Home's, FH7, and the CRM's, SD5):
 * cards on or off, up or down, and back to the starting cards. Only the
 * person looking sees their choice.
 */
export function DashboardCardChooser({
  tiles,
  options,
  maxTiles,
  saving,
  onChange,
  intro,
  startingNote,
  customised,
  onReset,
  hasData = () => true,
  footer,
}: {
  tiles: string[];
  options: Array<{ id: string; label: string }>;
  maxTiles: number;
  saving: boolean;
  onChange: (tiles: string[]) => void;
  intro: ReactNode;
  /** Where the starting cards came from (decision 660). */
  startingNote: string;
  customised: boolean;
  onReset: () => void;
  hasData?: (id: string) => boolean;
  footer?: ReactNode;
}) {
  const order = options.map((option) => option.id);
  const shown = tiles.map((id) => options.find((option) => option.id === id) ?? { id, label: id });
  const hidden = options.filter((option) => !tiles.includes(option.id));
  return (
    <div className={styles.chooser}>
      <p className={ui.muted}>{intro}</p>
      <ol className={styles.choices} aria-label="Cards shown">
        {shown.map((option, index) => (
          <li key={option.id} className={styles.choice}>
            <label className={ui.checkbox}>
              <input type="checkbox" checked disabled={saving || tiles.length === 1} onChange={() => onChange(toggleTile(tiles, option.id, false, order, maxTiles))} />
              <span>{option.label}{hasData(option.id) ? "" : " (nothing to show yet)"}</span>
            </label>
            <span className={styles.moves}>
              <button type="button" className={ui.linkButton} disabled={saving || index === 0} onClick={() => onChange(moveTile(tiles, option.id, -1))} aria-label={`Move ${option.label} up`}>Up</button>
              <button type="button" className={ui.linkButton} disabled={saving || index === shown.length - 1} onClick={() => onChange(moveTile(tiles, option.id, 1))} aria-label={`Move ${option.label} down`}>Down</button>
            </span>
          </li>
        ))}
      </ol>
      {hidden.length ? (
        <fieldset className={styles.hiddenCards}>
          <legend>Not shown</legend>
          {hidden.map((option) => (
            <label key={option.id} className={ui.checkbox}>
              <input type="checkbox" checked={false} disabled={saving || tiles.length >= maxTiles} onChange={() => onChange(toggleTile(tiles, option.id, true, order, maxTiles))} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <StartingCardsNote note={startingNote} customised={customised} saving={saving} onReset={onReset} />
      {footer ? <p className={ui.muted}>{footer}</p> : null}
    </div>
  );
}

/** Says where the starting cards came from, and offers them back once the person has their own (decision 660). */
export function StartingCardsNote({ note, customised, saving, onReset }: { note: string; customised: boolean; saving: boolean; onReset: () => void }) {
  return (
    <p className={ui.muted}>
      {customised ? "These are your own cards. " : "You haven't changed these yet. "}
      {note}{" "}
      {customised ? (
        <button type="button" className={ui.linkButton} disabled={saving} onClick={onReset}>
          Go back to the starting cards
        </button>
      ) : null}
    </p>
  );
}
