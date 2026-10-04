"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { Empty, Notice, ui } from "@/components/ui";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import type { Dashboard, Tile } from "@/lib/analytics/dashboards";
import type { QueryResult, ResultColumn, Visual } from "@/lib/analytics/query";
import { ApiError, api, errorMessage } from "@/lib/client/api";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { cmp, dec, sum, toPlainString } from "@/lib/money/decimal";
import styles from "./pinned-tile.module.css";

const CHARTS: ReadonlySet<Visual> = new Set(["column", "bar", "line", "area", "combo", "pie", "donut"]);
const TABLE_ROWS = 4;

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

function heading(label: string): string {
  const text = label.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** As on the dashboard: a pie keeps its 7 largest slices and adds the rest up (exactly) as Other. */
function foldSlices(rows: QueryResult["rows"], key: string): QueryResult["rows"] {
  if (rows.length <= 8) return rows;
  const sorted = [...rows].sort((a, b) => cmp(dec(b[key] ?? "0"), dec(a[key] ?? "0")));
  const other = sum(sorted.slice(7).map((row) => dec(row[key] ?? "0")));
  return [...sorted.slice(0, 7), { category: "Other", [key]: toPlainString(other) }];
}

type State =
  | { status: "loading" }
  | { status: "gone" }
  | { status: "error"; message: string; dashboard?: Dashboard; tile?: Tile }
  | { status: "ready"; dashboard: Dashboard; tile: Tile; result: QueryResult };

/** A missing dashboard or tile, one no longer shared, or Analytics switched off: the pin quietly drops off (decision 374). */
function gone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 409);
}

/**
 * An Analytics tile pinned to a page (decision 374). It runs the saved tile
 * through the dashboard query path (`dashboardId` + `tileId`), so the same
 * sharing rules apply, with the dashboard's own dates and no slicers.
 */
export function PinnedAnalyticsTile({ organisationId, dashboardId, tileId }: { organisationId: string; dashboardId: string; tileId: string }) {
  const key = `${organisationId}:${dashboardId}:${tileId}`;
  const [state, setState] = useState<{ key: string; value: State } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const set = (value: State) => {
      if (!cancelled) setState({ key, value });
    };
    void (async () => {
      let dashboard: Dashboard;
      try {
        dashboard = (await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, { query: { organisationId } })).dashboard;
      } catch (error) {
        set(gone(error) ? { status: "gone" } : { status: "error", message: errorMessage(error) });
        return;
      }
      const tile = dashboard.tiles.find((entry) => entry.id === tileId);
      if (!tile) {
        set({ status: "gone" });
        return;
      }
      try {
        const result = await api<QueryResult>("/api/analytics/query", {
          method: "POST",
          body: { organisationId, dashboardId, tileId, filters: { from: dashboard.settings.from, to: dashboard.settings.to, values: {} } },
        });
        set({ status: "ready", dashboard, tile, result });
      } catch (error) {
        set(gone(error) ? { status: "gone" } : { status: "error", message: errorMessage(error), dashboard, tile });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, organisationId, dashboardId, tileId]);

  const current: State = state?.key === key ? state.value : { status: "loading" };
  if (current.status === "gone") return null;
  const dashboard = current.status === "ready" || current.status === "error" ? current.dashboard : undefined;
  const tile = current.status === "ready" || current.status === "error" ? current.tile : undefined;
  const href = `/analytics/dashboards/${dashboardId}`;

  return (
    <section className={styles.tile} aria-label={tile ? `${tile.title}, from ${dashboard?.name ?? "Analytics"}` : "Analytics tile"}>
      <div className={styles.heading}>
        <Link href={href} className={styles.title}>
          {tile?.title ?? "Analytics tile"}
        </Link>
        {dashboard ? (
          <Link href={href} className={styles.source}>
            From {dashboard.name}
          </Link>
        ) : null}
      </div>
      {current.status === "loading" ? (
        <p className={ui.muted}>Working it out…</p>
      ) : current.status === "error" ? (
        <Notice tone="error">{current.message}</Notice>
      ) : (
        <PinnedTileResult tile={current.tile} result={current.result} />
      )}
    </section>
  );
}

function PinnedTileResult({ tile, result }: { tile: Tile; result: QueryResult }) {
  const measures = useMemo(() => result.columns.filter((column) => column.role === "measure"), [result.columns]);
  const chart = CHARTS.has(tile.visual) && measures.length > 0;
  const spec = useMemo<ChartSpec | null>(() => {
    if (!chart) return null;
    return {
      kind: tile.visual as ChartSpec["kind"],
      category: "category",
      series: measures.map((column, index) => ({
        field: column.key,
        label: column.label,
        // One axis only, as on the dashboard.
        ...(tile.visual === "combo" ? { as: index === 0 ? ("bar" as const) : ("line" as const) } : {}),
      })),
      valueFormat: measures[0]?.format === "money" ? "money" : "number",
      currency: "NZD",
      compact: true,
    };
  }, [chart, tile.visual, measures]);

  if (result.rows.length === 0) return <Empty>Nothing matches.</Empty>;
  if (tile.visual === "kpi" && measures.length > 0) {
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
  if (spec) {
    const rows = tile.visual === "pie" || tile.visual === "donut" ? foldSlices(result.rows, measures[0].key) : result.rows;
    return (
      <div className={styles.chart}>
        <Chart spec={spec} rows={rows} />
      </div>
    );
  }
  // Tables, and any visual a small tile can't draw: the first few rows.
  const more = result.rows.length - TABLE_ROWS;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column.key} className={column.role === "measure" ? ui.num : undefined}>
                {heading(column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.slice(0, TABLE_ROWS).map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column.key} className={column.role === "measure" ? ui.num : undefined}>
                  {showValue(row[column.key], column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 ? <p className={ui.muted}>{result.truncated ? "More" : `${more} more`} on the dashboard.</p> : null}
    </div>
  );
}
