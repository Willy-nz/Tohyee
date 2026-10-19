"use client";

import { useEffect, useRef, useState } from "react";
import type { CashFlowForecast } from "@/lib/cash-flow/types";
import { formatMoney } from "@/lib/format";
import styles from "./cash-flow-chart.module.css";

/**
 * The forecast's closing balance, period by period (#323 finding 5): a line
 * from the same response as the table below it, so the two always agree.
 * Zero is drawn, below-zero periods are marked, and the lowest is labelled.
 * The table stays the full, accessible view; hovering or focusing a period
 * shows its figures. Positions only use numbers for drawing; every figure
 * shown is the forecast's own string.
 */

const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

function compact(value: number): string {
  const sign = value < 0 ? "−" : "";
  const size = Math.abs(value);
  if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (size >= 1_000) return `${sign}$${(size / 1_000).toFixed(size >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}$${size.toFixed(0)}`;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  const top = Math.ceil(max / step) * step;
  for (let value = Math.floor(min / step) * step; value <= top + step / 1000; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

export function CashFlowChart({ forecast, labelOf }: { forecast: CashFlowForecast; labelOf: (index: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the frame's real width, so text stays its normal size on any screen.
  const frame = useRef<HTMLDivElement>(null);
  const [WIDTH, setWidth] = useState(720);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = [{ label: "Today", closing: forecast.opening }, ...forecast.periods.map((period, index) => ({ label: labelOf(index), closing: period.closing }))];
  const values = points.map((point) => Number(point.closing));
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const x = (index: number) => PAD.left + (index * (WIDTH - PAD.left - PAD.right)) / Math.max(1, points.length - 1);
  const y = (value: number) => PAD.top + ((high - value) * (HEIGHT - PAD.top - PAD.bottom)) / (high - low || 1);
  const path = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const lowestPoint = forecast.lowest.index + 1;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(WIDTH / 110))));
  const labelled = (index: number) => index === points.length - 1 || (index % labelEvery === 0 && points.length - 1 - index >= labelEvery);
  const summary = `Closing balance from ${formatMoney(forecast.opening)} today to ${formatMoney(forecast.periods[forecast.periods.length - 1].closing)} at the end; lowest ${formatMoney(forecast.lowest.closing)} in ${labelOf(forecast.lowest.index)}.`;
  const shown = hover ?? null;
  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <strong>Projected closing balance</strong>
        <span>{forecast.currencyCode} · a forecast, not money received. The table below has every figure.</span>
      </figcaption>
      <div className={styles.frame} ref={frame}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={styles.svg} role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? styles.zero : styles.grid} />
              <text x={PAD.left - 8} y={y(tick)} className={styles.tick} textAnchor="end" dominantBaseline="middle">
                {compact(tick)}
              </text>
            </g>
          ))}
          {/* Below zero, shaded so a shortfall isn't colour alone: it's also under the labelled zero line. */}
          <rect x={PAD.left} y={y(0)} width={WIDTH - PAD.left - PAD.right} height={Math.max(0, y(low) - y(0))} className={styles.below} />
          <path d={path} className={styles.line} />
          {points.map((point, index) =>
            labelled(index) ? (
              <text key={`label-${index}`} x={x(index)} y={HEIGHT - 8} className={styles.tick} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>
                {point.label}
              </text>
            ) : null,
          )}
          <circle cx={x(lowestPoint)} cy={y(values[lowestPoint])} r={5} className={Number(forecast.lowest.closing) < 0 ? styles.lowNegative : styles.low} />
          {shown !== null ? (
            <g>
              <line x1={x(shown)} x2={x(shown)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className={styles.crosshair} />
              <circle cx={x(shown)} cy={y(values[shown])} r={4} className={styles.dot} />
            </g>
          ) : null}
          {points.map((point, index) => (
            <rect
              key={`hit-${index}`}
              x={x(index) - (WIDTH - PAD.left - PAD.right) / Math.max(1, points.length - 1) / 2}
              y={PAD.top}
              width={(WIDTH - PAD.left - PAD.right) / Math.max(1, points.length - 1)}
              height={HEIGHT - PAD.top - PAD.bottom}
              className={styles.hit}
              onMouseEnter={() => setHover(index)}
            />
          ))}
        </svg>
        {shown !== null ? (
          <div className={styles.tooltip} style={{ left: `${(x(shown) / WIDTH) * 100}%` }} role="status">
            <span>{points[shown].label}</span>
            <strong>{formatMoney(points[shown].closing)}</strong>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
