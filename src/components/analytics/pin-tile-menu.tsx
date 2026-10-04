"use client";

import { useEffect, useRef, useState } from "react";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { api, errorMessage } from "@/lib/client/api";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { DASHBOARD_PAGES, MAX_DASHBOARD_TILES } from "@/lib/dashboard/pages";
import styles from "./pin-tile-menu.module.css";

type Preference = { hidden: boolean; tiles: string[] };

/**
 * "Pin to page" on a dashboard tile (decision 374): adds a reference to this
 * tile to the person's own tiles for a page with a dashboard frame, or
 * replaces one of them when the page already has four.
 */
export function PinTileMenu({
  organisationId,
  dashboardId,
  tileId,
}: {
  organisationId: string;
  dashboardId: string;
  tileId: string;
}) {
  const reference = analyticsTileReference(dashboardId, tileId);
  const menu = useRef<HTMLDetailsElement>(null);
  const [preferences, setPreferences] = useState<Record<string, Preference>>({});
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [loadingPages, setLoadingPages] = useState<string[]>([]);
  const [savingPage, setSavingPage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  // Escape or a click elsewhere closes the menu.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || !menu.current) return;
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    }
    function onPointer(event: PointerEvent) {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  async function load(pageId: string) {
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

  async function loadDashboards() {
    try {
      setDashboards((await api<{ dashboards: Dashboard[] }>("/api/analytics/dashboards", { query: { organisationId } })).dashboards);
    } catch {
      // Only used for the names of other pinned tiles.
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

  function pinnedLabel(id: string): string {
    const parsed = parseAnalyticsTileReference(id);
    const dashboard = parsed ? dashboards?.find((entry) => entry.id === parsed.dashboardId) : undefined;
    const tile = dashboard?.tiles.find((entry) => entry.id === parsed?.tileId);
    return dashboard && tile ? `${tile.title} · ${dashboard.name}` : "a pinned Analytics tile";
  }

  return (
    <details
      ref={menu}
      className={styles.menu}
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        setOpen(isOpen);
        if (!isOpen) return;
        // Fresh each time it opens, so a pin made elsewhere shows.
        for (const page of DASHBOARD_PAGES) void load(page.id);
        void loadDashboards();
      }}
    >
      <summary>Pin to page</summary>
      <div className={styles.list}>
        {DASHBOARD_PAGES.map((page) => {
          const preference = preferences[page.id];
          const tiles = preference?.tiles ?? [];
          const pinned = tiles.includes(reference);
          const loading = loadingPages.includes(page.id);
          const busy = savingPage === page.id;
          const labelFor = (id: string) => page.defaultTiles.find((tile) => tile.id === id)?.label ?? pinnedLabel(id);
          return (
            <section key={page.id} className={styles.page} aria-label={page.label}>
              <strong>{page.label}</strong>
              {loading && !preference ? <span className={styles.muted}>Loading…</span> : null}
              {preference && pinned ? (
                <>
                  <span className={styles.muted}>Pinned.</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const next = tiles.filter((tile) => tile !== reference);
                      // A page keeps at least one tile.
                      void save(page.id, next.length > 0 ? next : [page.defaultTiles[0].id]);
                    }}
                  >
                    Remove from {page.label}
                  </button>
                </>
              ) : null}
              {preference && !pinned && tiles.length < MAX_DASHBOARD_TILES ? (
                <button type="button" disabled={busy} onClick={() => void save(page.id, [...tiles, reference])}>
                  Pin to {page.label}
                </button>
              ) : null}
              {preference && !pinned && tiles.length >= MAX_DASHBOARD_TILES ? (
                <div className={styles.replacements}>
                  <span className={styles.muted}>{page.label} shows {MAX_DASHBOARD_TILES} tiles. Pin in place of:</span>
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
                      {labelFor(tile)}
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
