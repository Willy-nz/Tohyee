"use client";

import { useEffect, useState } from "react";
import type { QueryResult, TileQuery } from "@/lib/analytics/query";
import type { TileDrill, TileView } from "@/lib/analytics/report-view";
import { api, errorMessage } from "@/lib/client/api";

/** The report's dates and slicer choices a tile is answered with. */
export type TileFilters = { from: string; to: string; values: Record<string, string[]> };

/**
 * A tile's answer: its saved question (with `saved`), which is all a report
 * viewer may run, or a question being built. Kept until the question or the
 * filters change.
 */
export function useTileResult(
  organisationId: string,
  query: TileQuery | null,
  filters: TileFilters,
  saved?: { dashboardId: string; tileId: string },
  /** What the reader has drilled to or clicked (decision 756); for a question being built, the tiles it refers to too. */
  view?: { view: TileView; tiles?: Array<{ id: string; title: string; query: TileQuery | null; drill?: TileDrill }>; drill?: TileDrill },
) {
  const [state, setState] = useState<{ key: string; result: QueryResult | null; error: string | null } | null>(null);
  const key = JSON.stringify({ query, filters, saved, view });
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const question = saved ? { dashboardId: saved.dashboardId, tileId: saved.tileId } : { query };
    api<QueryResult>("/api/analytics/query", {
      method: "POST",
      body: {
        organisationId,
        ...question,
        filters: { from: filters.from || null, to: filters.to || null, values: filters.values },
        ...(view ? { view: view.view, ...(saved ? {} : { viewTiles: view.tiles, viewDrill: view.drill }) } : {}),
      },
    }).then(
      (result) => {
        if (!cancelled) setState({ key, result, error: null });
      },
      (error) => {
        if (!cancelled) setState({ key, result: null, error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `key` covers query and filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organisationId, key]);
  return state?.key === key ? state : null;
}

