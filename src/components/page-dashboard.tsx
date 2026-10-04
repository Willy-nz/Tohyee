"use client";

import { type ReactNode, useMemo, useState } from "react";
import { useApiData } from "@/components/hooks";
import { api, errorMessage } from "@/lib/client/api";
import styles from "./page-dashboard.module.css";

type Preference = { hidden: boolean; tiles: string[] };

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
  const state = useMemo(
    () =>
      override ??
      (loaded.data
        ? { hidden: loaded.data.hidden, tiles: loaded.data.tiles.length > 0 ? loaded.data.tiles : [...defaultTiles] }
        : { hidden: false, tiles: [...defaultTiles] }),
    [override, loaded.data, defaultTiles],
  );

  async function save(next: Preference) {
    setOverride(next);
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

  return {
    hidden: state.hidden,
    tiles: state.tiles,
    loading: loaded.loading,
    saving,
    error: error ?? loaded.error,
    setHidden: (hidden: boolean) => save({ hidden, tiles: state.tiles }),
    setTiles: (tiles: string[]) => save({ hidden: state.hidden, tiles }),
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
