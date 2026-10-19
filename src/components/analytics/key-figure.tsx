"use client";

import { makeNumberFormatter, type ChartFormat } from "@/lib/analytics/chart-format";
import { keyFigure } from "@/lib/analytics/key-figure";
import type { QueryResult, ResultColumn, TrendPoint } from "@/lib/analytics/query";
import styles from "./key-figure.module.css";

function formatterFor(column: ResultColumn, format: ChartFormat | undefined, index: number) {
  return makeNumberFormatter(format?.series?.[index]?.number, column.format === "money" ? "money" : "number");
}

const MONTH = new Intl.DateTimeFormat("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });

/** A small trend line by month. Drawn from display numbers only; the months and values are also there as text. */
function Sparkline({ trend, format }: { trend: TrendPoint[]; format: (value: string | null) => string }) {
  const points = trend.map((point) => ({ ...point, number: point.value === null ? null : Number(point.value) }));
  const numbers = points.flatMap((point) => (point.number === null || !Number.isFinite(point.number) ? [] : [point.number]));
  if (points.length < 2 || numbers.length < 2) return null;
  const width = 160;
  const height = 40;
  // Room for the end dot and its ring, so nothing is clipped.
  const inset = 6;
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const span = high - low || 1;
  const x = (index: number) => inset + (index * (width - inset * 2)) / (points.length - 1);
  const y = (value: number) => height - inset - ((value - low) * (height - inset * 2)) / span;
  const path = points
    .map((point, index) => (point.number === null ? null : `${x(index).toFixed(1)},${y(point.number).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const last = points.findLast((point) => point.number !== null)!;
  const lastIndex = points.lastIndexOf(last);
  return (
    <div className={styles.sparkline}>
      {/* The trend in the quiet colour; the latest month in the chart blue, ringed in the card colour. */}
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
        <polyline points={path} className={styles.sparkLine} />
        <circle cx={x(lastIndex)} cy={y(last.number!)} r="4" className={styles.sparkEnd} />
      </svg>
      <span className={styles.visuallyHidden}>
        By month: {trend.map((point) => `${MONTH.format(new Date(`${point.month}T00:00:00.000Z`))} ${point.value === null ? "none" : format(point.value)}`).join(", ")}
      </span>
    </div>
  );
}

/** A key figure (#334): the number, what it's compared with, the change with an arrow, and an optional trend. */
export function KeyFigureView({ result, format, compact = false }: { result: QueryResult; format?: ChartFormat; compact?: boolean }) {
  const figure = keyFigure(result, format);
  if (!figure) return null;
  const show = formatterFor(figure.column, format, 0);
  const change = format?.kpi?.change ?? "both";
  const tone = figure.good === null ? styles.same : figure.good ? styles.good : styles.bad;
  const arrow = figure.direction === "up" ? "▲" : figure.direction === "down" ? "▼" : "▶";
  const amount = figure.change === null ? null : show(figure.change.replace(/^-/, ""));
  const percent = figure.percent === null ? null : `${figure.percent.replace(/^-/, "")}%`;
  const words = figure.direction === "up" ? "Up" : figure.direction === "down" ? "Down" : "No change";
  const parts = figure.direction === "same" ? [] : [change !== "percent" ? amount : null, change !== "amount" ? percent : null].filter(Boolean);
  return (
    <div className={`${styles.kpi} ${compact ? styles.compact : ""}`}>
      <span className={styles.value}>{figure.value === null ? "—" : show(figure.value)}</span>
      {figure.comparison ? (
        figure.direction ? (
          <span className={`${styles.change} ${tone}`}>
            <span aria-hidden="true">{arrow} </span>
            {words}
            {parts.length ? ` ${parts.join(" · ")}` : ""}
            <span className={styles.against}>
              {" "}
              {figure.comparison.label === "target" ? "against the target" : `on the ${figure.comparison.label}`} ({show(figure.comparison.value)})
            </span>
          </span>
        ) : (
          <span className={styles.against}>Nothing to compare with for the {figure.comparison.label}{figure.comparison.label === "target" ? "" : " (set the dashboard's From and To)"}.</span>
        )
      ) : null}
      {result.trend?.length ? <Sparkline trend={result.trend} format={(value) => show(value)} /> : null}
      {figure.others.map((other) => (
        <span key={other.column.key} className={styles.against}>
          {other.column.label}: {other.value === null ? "—" : formatterFor(other.column, format, result.columns.filter((column) => column.role === "measure").indexOf(other.column))(other.value)}
        </span>
      ))}
    </div>
  );
}
