"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { formatChartValue, toEChartsOption, type ChartSpec, type KpiSummary } from "@/lib/analytics/chart-spec";
import { CHART_TOKENS, chartThemeFromTokens, readChartTheme, type ChartTheme } from "@/lib/charts/theme";
import { useReportThemeKey } from "@/components/analytics/report-theme";
import { isMapKind, loadNzMaps } from "@/components/analytics/nz-maps";
import styles from "./chart.module.css";

type ChartProps = {
  spec: ChartSpec;
  rows: Record<string, string | number | null>[];
  /** Drawing height in pixels (a tile's Small, Medium or Large); the stylesheet's otherwise. */
  height?: number;
  /** A click on a mark, by its row (decision 754): to filter other tiles or drill down. */
  onPick?: (rowIndex: number) => void;
  /** Rows to draw at full strength, the rest faded (highlight, decision 754); left out, all. */
  highlight?: number[] | null;
};

/** Fades every mark but the highlighted rows' (with text in the tooltip and hidden table as before). */
function faded(option: EChartsOption, rows: number, keep: Set<number>): EChartsOption {
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  return {
    ...option,
    series: series.map((entry) => {
      const data = (entry as { data?: unknown[] }).data;
      if (!Array.isArray(data) || data.length !== rows) return entry;
      return {
        ...entry,
        data: data.map((item, index) => {
          if (keep.has(index)) return item;
          const value = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item };
          return { ...value, itemStyle: { ...((value.itemStyle as object) ?? {}), opacity: 0.25 } };
        }),
      };
    }),
  } as EChartsOption;
}

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

export function Chart({ spec, rows, height, onPick, highlight }: ChartProps) {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const isKpi = spec.kind === "kpi";
  // Maps need the New Zealand boundaries registered before they're drawn.
  const isMap = isMapKind(spec.kind);
  const [theme, setTheme] = useState(DEFAULT_THEME);
  // A report theme (decision 668) changes the variables the chart reads.
  const themeKey = useReportThemeKey();
  const option = useMemo(() => {
    const drawn = toEChartsOption(spec, rows, theme);
    return highlight && isChartOption(drawn) ? faded(drawn, rows.length, new Set(highlight)) : drawn;
  }, [spec, rows, theme, highlight]);
  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);
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
    const chart = chartRef.current;
    if (isKpi || !chart || !isChartOption(option)) return;
    if (!isMap) {
      chart.setOption(option, { notMerge: true });
      return;
    }
    void loadNzMaps().then(() => {
      if (chartRef.current === chart && optionRef.current === option) chart.setOption(option, { notMerge: true });
    });
  }, [isKpi, isMap, option]);

  useEffect(() => {
    if (isKpi) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let chart: ECharts | null = null;
    const resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(container);

    void Promise.all([import("echarts"), isMap ? loadNzMaps() : null]).then(([echarts]) => {
      if (disposed) return;
      chart = echarts.init(container, undefined, { renderer: "svg" });
      chartRef.current = chart;
      if (isChartOption(optionRef.current)) chart.setOption(optionRef.current);
      chart.on("click", (params) => {
        if (typeof params.dataIndex === "number") pickRef.current?.(params.dataIndex);
      });
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      chart?.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
    // A chart that becomes a map is drawn again once the boundaries are in.
  }, [isKpi, isMap]);

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
        <div ref={containerRef} className={`${styles.canvas} ${onPick ? styles.pickable : ""}`} style={height ? { height, minHeight: height } : undefined} role="img" aria-label={title} />
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
