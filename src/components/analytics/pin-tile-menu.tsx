"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { analyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { DASHBOARD_PAGES } from "@/lib/dashboard/pages";
import styles from "./pin-tile-menu.module.css";

type Preference = { hidden: boolean; tiles: string[] };

export function PinTileMenu({
  organisationId,
  dashboardId,
  dashboardName,
  tileId,
  tileTitle,
}: {
  organisationId: string;
  dashboardId: string;
  dashboardName: string;
  tileId: string;
  tileTitle: string;
}) {
  const reference = analyticsTileReference(dashboardId, tileId);
  const [preferences, setPreferences] = useState<Record<string, Preference>>({});
  const [loadingPages, setLoadingPages] = useState<string[]>([]);
  const [savingPage, setSavingPage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function load(pageId: string) {
    if (preferences[pageId] || loadingPages.includes(pageId)) return;
    setLoadingPages((current) => [...current, pageId]);
    setErrors((current) => ({ ...current, [pageId]: "" }));
    try {
      const preference = await api<Preference>("/api/dashboard-preferences", { query: { organisationId, page: pageId } });
      setPreferences((current) => ({ ...current, [pageId]: preference }));
    } catch (error) {
      setErrors((current) => ({ ...current, [pageId]: errorMessage(error) }));
    } finally {
      setLoadingPages((current) => current.filter((entry) => entry !== pageId));
    }
  }

  async function save(pageId: string, tiles: string[]) {
    const preference = preferences[pageId];
    if (!preference) return;
    setSavingPage(pageId);
    setErrors((current) => ({ ...current, [pageId]: "" }));
    try {
      const saved = await api<Preference>("/api/dashboard-preferences", {
        method: "PUT",
        body: { organisationId, page: pageId, hidden: preference.hidden, tiles },
      });
      setPreferences((current) => ({ ...current, [pageId]: saved }));
    } catch (error) {
      setErrors((current) => ({ ...current, [pageId]: errorMessage(error) }));
    } finally {
      setSavingPage(null);
    }
  }

  return (
    <details
      className={styles.menu}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          for (const page of DASHBOARD_PAGES) void load(page.id);
        }
      }}
    >
      <summary>Pin to page</summary>
      <div className={styles.list}>
        {DASHBOARD_PAGES.map((page) => {
          const preference = preferences[page.id];
          const tiles = preference?.tiles ?? [];
          const pinnedAt = tiles.indexOf(reference);
          const loading = loadingPages.includes(page.id);
          const busy = savingPage === page.id;
          const labelFor = (id: string) =>
            page.defaultTiles.find((tile) => tile.id === id)?.label ?? (id === reference ? `${tileTitle} · ${dashboardName}` : "Pinned Analytics tile");
          return (
            <section key={page.id} className={styles.page}>
              <strong>{page.label}</strong>
              {loading || (!preference && !errors[page.id]) ? <span>Loading…</span> : null}
              {preference && pinnedAt >= 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const next = tiles.filter((tile) => tile !== reference);
                    if (next.length === 0) next.push(page.defaultTiles[0].id);
                    void save(page.id, next);
                  }}
                >
                  Remove from {page.label}
                </button>
              ) : null}
              {preference && pinnedAt < 0 && tiles.length < 4 ? (
                <button type="button" disabled={busy} onClick={() => void save(page.id, [...tiles, reference])}>
                  Pin to {page.label}
                </button>
              ) : null}
              {preference && pinnedAt < 0 && tiles.length >= 4 ? (
                <div className={styles.replacements}>
                  {tiles.map((tile, index) => (
                    <button
                      key={`${tile}-${index}`}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const next = [...tiles];
                        next[index] = reference;
                        void save(page.id, next);
                      }}
                    >
                      Replace {labelFor(tile)}
                    </button>
                  ))}
                </div>
              ) : null}
              {errors[page.id] ? <span className={styles.error}>{errors[page.id]}</span> : null}
            </section>
          );
        })}
      </div>
    </details>
  );
}
