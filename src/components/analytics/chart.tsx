"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { formatChartValue, toEChartsOption, type ChartSpec, type KpiSummary } from "@/lib/analytics/chart-spec";
import { CHART_TOKENS, chartThemeFromTokens, readChartTheme, type ChartTheme } from "@/lib/charts/theme";
import { useReportThemeKey } from "@/components/analytics/report-theme";
import styles from "./chart.module.css";

type ChartProps = {
  spec: ChartSpec;
  rows: Record<string, string | number | null>[];
  /** Drawing height in pixels (a tile's Small, Medium or Large); the stylesheet's otherwise. */
  height?: number;
};

const DEFAULT_THEME: ChartTheme = chartThemeFromTokens(CHART_TOKENS.light);

/**
 * The shared chart theme (decision 599), read from where the chart sits so it
 * follows light and dark, and a shaded card's own surface for the gaps.
 */
function readTheme(element: Element | null): ChartTheme {
  const css = getComputedStyle(element ?? document.documentElement);
  return readChartTheme((name) => css.getPropertyValue(name));
}

function isChartOption(option: EChartsOption | KpiSummary): option is EChartsOption {
  return "series" in option;
}

function isKpiSummary(option: EChartsOption | KpiSummary): option is KpiSummary {
  return !isChartOption(option);
}

export function Chart({ spec, rows, height }: ChartProps) {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const isKpi = spec.kind === "kpi";
  const [theme, setTheme] = useState(DEFAULT_THEME);
  // A report theme (decision 668) changes the variables the chart reads.
  const themeKey = useReportThemeKey();
  const option = useMemo(() => toEChartsOption(spec, rows, theme), [spec, rows, theme]);
  const optionRef = useRef(option);
  const title = spec.title || spec.series.map((series) => series.label).join(", ") || "Chart";

  useEffect(() => {
    const updateTheme = () => setTheme(readTheme(containerRef.current));
    updateTheme();
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", updateTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", updateTheme);
    };
  }, [themeKey]);

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
        <div ref={containerRef} className={styles.canvas} style={height ? { height, minHeight: height } : undefined} role="img" aria-label={title} />
      )}
      {/* A table can't be squeezed to 1px, so it's hidden inside a box that can (otherwise a long one stretches the page). */}
      <div className={styles.visuallyHidden}>
      <table>
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
      </div>
    </section>
  );
}
