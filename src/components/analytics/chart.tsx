"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { formatChartValue, toEChartsOption, type ChartSpec, type ChartTheme, type KpiSummary } from "@/lib/analytics/chart-spec";
import styles from "./chart.module.css";

type ChartProps = {
  spec: ChartSpec;
  palette?: "default" | "accent";
  rows: Record<string, string | number | null>[];
};

const CHART_SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

const DEFAULT_THEME: ChartTheme = {
  text: "#1b2533",
  mutedText: "#546072",
  grid: "#dde2e9",
  background: "#ffffff",
  palette: CHART_SLOTS,
};

function readTheme(palette: "default" | "accent"): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    text: color("--text", DEFAULT_THEME.text),
    mutedText: color("--text-muted", DEFAULT_THEME.mutedText),
    grid: color("--border", DEFAULT_THEME.grid),
    background: color("--surface", DEFAULT_THEME.background),
    // The chart series colours in their fixed order (--chart-1 to --chart-8 in globals.css).
    palette: palette === "accent" ? [color("--accent", "#1f5fae"), color("--text-muted", "#546072"), color("--text", "#1b2533")] : CHART_SLOTS.map((fallback, index) => color(`--chart-${index + 1}`, fallback)),
  };
}

function isChartOption(option: EChartsOption | KpiSummary): option is EChartsOption {
  return "series" in option;
}

function isKpiSummary(option: EChartsOption | KpiSummary): option is KpiSummary {
  return !isChartOption(option);
}

export function Chart({ spec, rows, palette = "default" }: ChartProps) {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const isKpi = spec.kind === "kpi";
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const option = useMemo(() => toEChartsOption(spec, rows, theme), [spec, rows, theme]);
  const optionRef = useRef(option);
  const title = spec.title || spec.series.map((series) => series.label).join(", ") || "Chart";

  useEffect(() => {
    const updateTheme = () => setTheme(readTheme(palette));
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", updateTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", updateTheme);
    };
  }, [palette]);

  useEffect(() => {
    optionRef.current = option;
    if (!isKpi && chartRef.current && isChartOption(option)) {
      chartRef.current.setOption(option, { notMerge: true });
    }
  }, [isKpi, option]);

  useEffect(() => {
    if (isKpi) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let chart: ECharts | null = null;
    const resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(container);

    void import("echarts").then((echarts) => {
      if (disposed) return;
      chart = echarts.init(container, undefined, { renderer: "svg" });
      chartRef.current = chart;
      if (isChartOption(optionRef.current)) chart.setOption(optionRef.current);
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      chart?.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [isKpi]);

  const summary = isKpi && isKpiSummary(option) ? option : null;
  const previous = summary?.previous ?? null;
  return (
    <section className={styles.chart} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.visuallyHidden}>{title}</h2>
      {summary ? (
        <div className={styles.kpi} aria-label={title}>
          {spec.title ? <span className={styles.kpiTitle}>{spec.title}</span> : null}
          <span className={styles.kpiValue}>{formatChartValue(summary.value, spec)}</span>
          {previous !== null ? (
            <span className={styles.kpiChange}>
              Previous {formatChartValue(previous, spec)}
              {summary.change !== undefined ? ` · Change ${formatChartValue(summary.change, spec)}` : ""}
            </span>
          ) : null}
        </div>
      ) : (
        <div ref={containerRef} className={styles.canvas} role="img" aria-label={title} />
      )}
      <table className={styles.visuallyHidden}>
        <caption>{title} data</caption>
        <thead>
          <tr>
            <th scope="col">{spec.category}</th>
            {spec.series.map((series) => <th scope="col" key={series.field}>{series.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">{String(row[spec.category] ?? "")}</th>
              {spec.series.map((series) => (
                <td key={series.field}>{row[series.field] === null ? "" : String(row[series.field] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
