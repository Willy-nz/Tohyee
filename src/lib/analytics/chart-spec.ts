import type { EChartsOption } from "echarts";
import { dec, sub, toFixedString } from "@/lib/money/decimal";

export type ChartKind = "bar" | "column" | "line" | "area" | "combo" | "pie" | "donut" | "kpi";

export type ChartSpec = {
  kind: ChartKind;
  category: string;
  series: { field: string; label: string; as?: "bar" | "line"; axis?: "left" | "right" }[];
  stacked?: boolean;
  valueFormat: "money" | "number" | "percent";
  currency?: string;
  title?: string;
};

export type ChartTheme = {
  text: string;
  mutedText: string;
  grid: string;
  background: string;
  palette: string[];
};

export type KpiSummary = {
  value: string | null;
  previous?: string | null;
  change?: string;
};

type ChartRow = Record<string, string | number | null>;

function validateFields(spec: ChartSpec, rows: ChartRow[]) {
  if (rows.length === 0) return;
  const fields = [spec.category, ...spec.series.map((series) => series.field)];
  for (const field of fields) {
    if (!rows.every((row) => Object.prototype.hasOwnProperty.call(row, field))) {
      throw new Error(`Chart field "${field}" is missing from the rows.`);
    }
  }
}

function decimalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  dec(text);
  return text;
}

function kpiSummary(spec: ChartSpec, rows: ChartRow[]): KpiSummary {
  const row = rows[0];
  const value = decimalString(row?.[spec.series[0].field]);
  const previousField = spec.series[1]?.field;
  if (!previousField) return { value };

  const previous = decimalString(row?.[previousField]);
  if (value === null || previous === null) return { value, previous };

  const currentDecimal = dec(value);
  const previousDecimal = dec(previous);
  const scale = Math.max(currentDecimal.scale, previousDecimal.scale);
  return { value, previous, change: toFixedString(sub(currentDecimal, previousDecimal), scale) };
}

/** Converts source values to numbers only at the display boundary; this is for chart rendering, never calculations. */
function displayNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeFormatter(spec: ChartSpec, compact: boolean) {
  const options: Intl.NumberFormatOptions =
    spec.valueFormat === "money"
      ? {
          style: "currency",
          currency: spec.currency ?? "NZD",
          ...(compact ? { notation: "compact" as const, maximumFractionDigits: 1 } : {}),
        }
      : spec.valueFormat === "percent"
        ? { style: "percent", maximumFractionDigits: compact ? 1 : 2 }
        : compact
          ? { notation: "compact", maximumFractionDigits: 1 }
          : { maximumFractionDigits: 20 };
  const formatter = new Intl.NumberFormat("en-NZ", options);
  return (value: number | string) => {
    const number = displayNumber(value);
    return number === null ? "" : formatter.format(number);
  };
}

export function formatChartValue(value: string | number | null, spec: ChartSpec): string {
  return value === null ? "—" : makeFormatter(spec, false)(value);
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatCategories(values: unknown[]): string[] {
  if (!values.every(isoDate)) return values.map((value) => String(value ?? ""));
  const months = values.every((value) => value.slice(-2) === "01");
  const formatter = new Intl.DateTimeFormat("en-NZ", months ? { month: "short", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return values.map((value) => formatter.format(new Date(`${value}T00:00:00.000Z`)));
}

function numberAxis(format: (value: number | string) => string, theme: ChartTheme, position: "left" | "right" = "left") {
  return {
    type: "value" as const,
    position,
    axisLabel: { color: theme.mutedText, formatter: format },
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: theme.grid } },
  };
}

export function toEChartsOption(spec: ChartSpec, rows: ChartRow[], theme: ChartTheme): EChartsOption | KpiSummary {
  validateFields(spec, rows);
  if (spec.series.length === 0) throw new Error("A chart spec must include at least one series.");
  if (spec.kind === "kpi") return kpiSummary(spec, rows);

  const categories = formatCategories(rows.map((row) => row[spec.category]));
  const compactFormatter = makeFormatter(spec, true);
  const fullFormatter = makeFormatter(spec, false);
  const horizontal = spec.kind === "bar";
  const common: EChartsOption = {
    backgroundColor: theme.background,
    color: theme.palette,
    textStyle: { color: theme.text },
    ...(spec.title ? { title: { text: spec.title, textStyle: { color: theme.text } } } : {}),
    legend: { show: spec.series.length > 1, textStyle: { color: theme.mutedText } },
    tooltip: {
      trigger: spec.kind === "pie" || spec.kind === "donut" ? "item" as const : "axis" as const,
      valueFormatter: (value: unknown) =>
        fullFormatter(typeof value === "string" || typeof value === "number" ? value : String(value ?? "")),
      backgroundColor: theme.background,
      borderColor: theme.grid,
      textStyle: { color: theme.text },
    },
  };

  if (spec.kind === "pie" || spec.kind === "donut") {
    const band = 70 / spec.series.length;
    const series = spec.series.map((item, index) => ({
      name: item.label,
      type: "pie" as const,
      radius: spec.kind === "donut" && spec.series.length === 1
        ? ["45%", "70%"]
        : spec.kind === "donut"
          ? [`${Math.round(45 + index * (25 / spec.series.length))}%`, `${Math.round(45 + (index + 1) * (25 / spec.series.length))}%`]
          : [`${Math.round(index * band)}%`, `${Math.round((index + 1) * band)}%`],
      data: rows.flatMap((row, rowIndex) => {
        const value = displayNumber(row[item.field]);
        return value === null ? [] : [{ name: categories[rowIndex], value }];
      }),
      label: { color: theme.text },
    }));
    return { ...common, series };
  }

  const hasRightAxis = spec.kind === "combo" && spec.series.some((item) => item.axis === "right");
  const series = spec.series.map((item, index) => {
    const type = spec.kind === "combo" ? item.as ?? "bar" : spec.kind === "line" || spec.kind === "area" ? "line" : "bar";
    return {
      name: item.label,
      type,
      data: rows.map((row) => displayNumber(row[item.field])),
      ...(spec.stacked ? { stack: "total" } : {}),
      ...(spec.kind === "area" ? { areaStyle: {} } : {}),
      ...(type === "line" ? { smooth: false, showSymbol: true } : {}),
      ...(hasRightAxis ? { yAxisIndex: item.axis === "right" ? 1 : 0 } : {}),
      itemStyle: { color: theme.palette[index % theme.palette.length] },
      lineStyle: { color: theme.palette[index % theme.palette.length] },
    };
  });

  const categoryAxis = {
    type: "category" as const,
    data: categories,
    axisLabel: { color: theme.mutedText },
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    splitLine: { show: false },
  };
  return {
    ...common,
    xAxis: horizontal ? numberAxis(compactFormatter, theme) : categoryAxis,
    yAxis: horizontal
      ? { ...categoryAxis, data: categories }
      : hasRightAxis
        ? [numberAxis(compactFormatter, theme), numberAxis(compactFormatter, theme, "right")]
        : [numberAxis(compactFormatter, theme)],
    series,
  };
}
