"use client";

import { makeNumberFormatter, type ChartFormat } from "@/lib/analytics/chart-format";
import { figureColour, figureStyle, keyFigure, keyFigureNumbers, sparkPoints } from "@/lib/analytics/key-figure";
import type { QueryResult, ResultColumn, TrendPoint } from "@/lib/analytics/query";
import { adaptForDark } from "@/lib/charts/colour-check";
import styles from "./key-figure.module.css";

function formatterFor(column: ResultColumn, format: ChartFormat | undefined, index: number) {
  return makeNumberFormatter(format?.series?.[index]?.number ?? column.number, column.format === "money" ? "money" : "number");
}

const MONTH = new Intl.DateTimeFormat("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });

/** A colour chosen for light, with its dark version (decision 672). */
function bothModes(hex: string, role: "mark" | "text"): string {
  return `light-dark(${hex}, ${adaptForDark(hex, role)})`;
}

/**
 * A small trend by month (#334), as a line, an area or columns (#376). Drawn
 * from display numbers only; the months and values are also there as text.
 */
function Sparkline({ trend, format, style = "line", colour }: { trend: TrendPoint[]; format: (value: string | null) => string; style?: "line" | "area" | "column"; colour?: string }) {
  const width = 160;
  const height = 40;
  const inset = 6;
  const points = sparkPoints(trend, width, height, inset);
  if (!points.length) return null;
  const drawn = points.filter((point): point is { x: number; y: number; value: number } => point.y !== null);
  const path = drawn.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const last = drawn[drawn.length - 1];
  const custom = colour ? bothModes(colour, "mark") : undefined;
  const step = (width - inset * 2) / Math.max(points.length - 1, 1);
  const barWidth = Math.max(2, Math.min(10, step * 0.6));
  return (
    <div className={styles.sparkline}>
      {/* The trend in the quiet colour (or the one chosen); the latest month in the chart blue, ringed in the card colour. */}
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
        {style === "column" ? (
          drawn.map((point, index) => (
            <rect
              key={index}
              x={(point.x - barWidth / 2).toFixed(1)}
              y={point.y.toFixed(1)}
              width={barWidth.toFixed(1)}
              height={Math.max(1, height - inset - point.y).toFixed(1)}
              rx="1.5"
              className={point === last ? styles.sparkBarLast : styles.sparkBar}
              style={custom && point !== last ? { fill: custom } : undefined}
            />
          ))
        ) : (
          <>
            {style === "area" ? (
              <polygon
                points={`${drawn[0].x.toFixed(1)},${height - inset} ${path} ${last.x.toFixed(1)},${height - inset}`}
                className={styles.sparkArea}
                style={custom ? { fill: custom } : undefined}
              />
            ) : null}
            <polyline points={path} className={styles.sparkLine} style={custom ? { stroke: custom } : undefined} />
            <circle cx={last.x} cy={last.y} r="4" className={styles.sparkEnd} />
          </>
        )}
      </svg>
      <span className={styles.visuallyHidden}>
        By month: {trend.map((point) => `${MONTH.format(new Date(`${point.month}T00:00:00.000Z`))} ${point.value === null ? "none" : format(point.value)}`).join(", ")}
      </span>
    </div>
  );
}

/** A key figure (#334, #376): the number, what it's compared with, the change with an arrow, and an optional trend. */
export function KeyFigureView({ result, format, compact = false }: { result: QueryResult; format?: ChartFormat; compact?: boolean }) {
  const figure = keyFigure(result, format);
  if (!figure) return null;
  const kpi = format?.kpi ?? {};
  const measures = result.columns.filter((column) => column.role === "measure");
  const show = formatterFor(figure.column, format, 0);
  const change = kpi.change ?? "both";
  const tone = figure.good === null ? styles.same : figure.good ? styles.good : styles.bad;
  const arrow = figure.direction === "up" ? "▲" : figure.direction === "down" ? "▼" : "▶";
  const amount = figure.change === null ? null : show(figure.change.replace(/^-/, ""));
  const percent = figure.percent === null ? null : `${figure.percent.replace(/^-/, "")}%`;
  const words = figure.direction === "up" ? "Up" : figure.direction === "down" ? "Down" : "No change";
  const parts = figure.direction === "same" ? [] : [change !== "percent" ? amount : null, change !== "amount" ? percent : null].filter(Boolean);
  const colour = figureColour(figure, format);
  const numberClass = colour === "good" ? styles.good : colour === "bad" ? styles.bad : "";
  const numberStyle: Record<string, string | number | undefined> = { ...figureStyle(format), ...(colour && colour !== "good" && colour !== "bad" ? { color: bothModes(colour, "text") } : {}) };
  // Compact (a pinned tile) keeps its own small size.
  if (compact) delete numberStyle.fontSize;
  const label = kpi.label ?? "none";
  const name = <span className={styles.name}>{figure.column.label}</span>;
  const icon =
    kpi.icon === "arrow" && figure.direction ? (
      <span className={`${styles.icon} ${tone}`} aria-hidden="true">{arrow}</span>
    ) : kpi.icon === "dot" ? (
      <span className={`${styles.icon} ${styles.dot} ${numberClass}`} style={colour && colour !== "good" && colour !== "bad" ? { color: bothModes(colour, "text") } : undefined} aria-hidden="true">●</span>
    ) : null;

  if (kpi.multi && measures.length > 1) {
    // Several numbers in one card, each with its name (Power BI's multi-row card).
    const numbers = keyFigureNumbers(result);
    return (
      <div className={`${styles.multi} ${compact ? styles.compact : ""}`} style={kpi.align ? { justifyItems: numberStyle.justifyItems as string, textAlign: kpi.align } : undefined}>
        {numbers.map((entry, index) => {
          const own = formatterFor(entry.column, format, measures.indexOf(entry.column));
          return (
            <div key={entry.column.key} className={styles.multiItem}>
              {label !== "below" ? <span className={styles.name}>{entry.column.label}</span> : null}
              <span className={`${styles.value} ${index === 0 ? numberClass : ""}`} style={index === 0 ? numberStyle : { ...numberStyle, color: undefined }}>
                {entry.value === null ? "—" : own(entry.value)}
              </span>
              {label === "below" ? <span className={styles.name}>{entry.column.label}</span> : null}
            </div>
          );
        })}
        {figure.comparison && figure.direction ? (
          <span className={`${styles.change} ${tone}`}>
            <span aria-hidden="true">{arrow} </span>
            {figure.column.label} {words.toLowerCase()}
            {parts.length ? ` ${parts.join(" · ")}` : ""}
          </span>
        ) : null}
        {result.trend?.length ? <Sparkline trend={result.trend} format={(value) => show(value)} style={kpi.sparkline} colour={kpi.sparkColor} /> : null}
      </div>
    );
  }

  return (
    <div className={`${styles.kpi} ${compact ? styles.compact : ""}`} style={kpi.align ? { justifyItems: numberStyle.justifyItems as string, textAlign: kpi.align } : undefined}>
      {label === "above" ? name : null}
      <span className={`${styles.value} ${numberClass}`} style={numberStyle}>
        {icon}
        {figure.value === null ? "—" : show(figure.value)}
      </span>
      {label === "below" ? name : null}
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
      {result.trend?.length ? <Sparkline trend={result.trend} format={(value) => show(value)} style={kpi.sparkline} colour={kpi.sparkColor} /> : null}
      {figure.others.map((other) => (
        <span key={other.column.key} className={styles.against}>
          {other.column.label}: {other.value === null ? "—" : formatterFor(other.column, format, measures.indexOf(other.column))(other.value)}
        </span>
      ))}
    </div>
  );
}
