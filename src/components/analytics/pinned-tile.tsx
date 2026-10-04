"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { Empty, Notice, ui } from "@/components/ui";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import type { Dashboard, Tile } from "@/lib/analytics/dashboards";
import type { QueryResult, ResultColumn } from "@/lib/analytics/query";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { useApiData } from "@/components/hooks";
import styles from "./pinned-tile.module.css";

function showValue(value: string | null, column: ResultColumn): string {
  if (value === null) return "";
  switch (column.format) {
    case "money":
      return `$${formatMoney(value)}`;
    case "number":
      return formatQuantity(formatMoney(value, 4));
    case "integer":
      return formatQuantity(value);
    case "date":
      return formatDate(value);
    default:
      return value;
  }
}

export function PinnedAnalyticsTile({
  organisationId,
  dashboardId,
  tileId,
}: {
  organisationId: string;
  dashboardId: string;
  tileId: string;
}) {
  const loaded = useApiData<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, { organisationId });
  const dashboard = loaded.data?.dashboard ?? null;
  const tile = dashboard?.tiles.find((entry) => entry.id === tileId) ?? null;
  const filters = { from: dashboard?.settings.from ?? null, to: dashboard?.settings.to ?? null, values: {} };
  const key = JSON.stringify({ organisationId, dashboardId, tileId, query: tile?.query, filters });
  const [state, setState] = useState<{ key: string; result: QueryResult | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!tile) return;
    let cancelled = false;
    api<QueryResult>("/api/analytics/query", {
      method: "POST",
      body: { organisationId, dashboardId, tileId, filters },
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
    // The key covers the saved tile and its dashboard dates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organisationId, key]);

  if (loaded.error) return <section className={styles.tile}><Notice tone="error">{loaded.error}</Notice></section>;
  if (!dashboard) return <section className={styles.tile}><p className={ui.muted}>Loading Analytics tile…</p></section>;
  if (!tile) return <section className={styles.tile}><Notice tone="info">This Analytics tile is no longer available.</Notice></section>;
  const result = state?.key === key ? state : null;

  return (
    <section className={styles.tile} aria-label={tile.title}>
      <div className={styles.heading}>
        <h2>{tile.title}</h2>
        <Link href={`/analytics/dashboards/${dashboard.id}`}>From {dashboard.name}</Link>
      </div>
      {!result ? <p className={ui.muted}>Working it out…</p> : result.error ? <Notice tone="error">{result.error}</Notice> : <PinnedTileResult tile={tile} result={result.result!} />}
    </section>
  );
}

function PinnedTileResult({ tile, result }: { tile: Tile; result: QueryResult }) {
  const measures = result.columns.filter((column) => column.role === "measure");
  const spec = useMemo<ChartSpec | null>(() => {
    if (tile.visual === "table" || tile.visual === "kpi") return null;
    return {
      kind: tile.visual,
      category: "category",
      series: measures.map((column, index) => ({
        field: column.key,
        label: column.label,
        ...(tile.visual === "combo" ? { as: index === 0 ? ("bar" as const) : ("line" as const) } : {}),
      })),
      valueFormat: measures[0]?.format === "money" ? "money" : "number",
      currency: "NZD",
    };
  }, [tile.visual, measures]);

  if (result.rows.length === 0) return <Empty>Nothing matches.</Empty>;
  if (tile.visual === "kpi") {
    return (
      <div className={styles.kpi}>
        <span className={styles.kpiValue}>{showValue(result.rows[0][measures[0].key], measures[0])}</span>
        {measures.slice(1).map((column) => (
          <span key={column.key} className={ui.muted}>
            {column.label}: {showValue(result.rows[0][column.key], column)}
          </span>
        ))}
      </div>
    );
  }
  if (tile.visual === "table") {
    return (
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>
            {result.rows.slice(0, 4).map((row, index) => (
              <tr key={index}>{result.columns.map((column) => <td key={column.key}>{showValue(row[column.key], column)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <div className={styles.chart}><Chart spec={spec!} rows={result.rows} /></div>;
}
