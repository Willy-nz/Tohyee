import type { EChartsOption } from "echarts";
import {
  HUES,
  PALETTES,
  makeNumberFormatter,
  type AxisFormat,
  type ChartFormat,
  type Hue,
  type NumberFormat,
  type ValueKind,
} from "@/lib/analytics/chart-format";
import { dec, sub, sum, toFixedString, toPlainString } from "@/lib/money/decimal";

export type ChartKind = "bar" | "column" | "line" | "area" | "combo" | "pie" | "donut" | "kpi";

export type ChartSeries = {
  field: string;
  label: string;
  as?: "bar" | "line";
  axis?: "left" | "right";
  /** Money or a plain number (from the query column); the default for its number format. */
  kind?: ValueKind;
};

export type ChartSpec = {
  kind: ChartKind;
  category: string;
  series: ChartSeries[];
  stacked?: boolean;
  valueFormat: "money" | "number" | "percent";
  currency?: string;
  title?: string;
  /** A small chart (a pinned tile): tight margins so the plot isn't squeezed out. */
  compact?: boolean;
  /** How it looks (#333); series settings are by position. */
  format?: ChartFormat;
};

export type ChartTheme = {
  text: string;
  mutedText: string;
  grid: string;
  background: string;
  /** The eight chart colours in their checked order (--chart-1 to --chart-8). */
  palette: string[];
  /** Four steps of blue (--chart-blues-1 to 4), for the "Tohyee blues" colours. */
  blues?: string[];
  /** Below-zero bars when "red when negative" is on (--chart-negative). */
  negative?: string;
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

function seriesKind(spec: ChartSpec, index: number): ValueKind {
  return spec.series[index]?.kind ?? (spec.valueFormat === "money" ? "money" : "number");
}

function seriesNumber(spec: ChartSpec, index: number): NumberFormat | undefined {
  return spec.format?.series?.[index]?.number ?? (spec.valueFormat === "percent" ? { style: "percent" } : undefined);
}

function seriesFormatter(spec: ChartSpec, index: number, axis = false) {
  const format = makeNumberFormatter(seriesNumber(spec, index), seriesKind(spec, index), { currency: spec.currency, axis });
  return (value: number | string) => format(value);
}

export function formatChartValue(value: string | number | null, spec: ChartSpec, index = 0): string {
  return value === null ? "—" : seriesFormatter(spec, index)(value);
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function numberAxis(
  format: (value: number | string) => string,
  theme: ChartTheme,
  position: "left" | "right" = "left",
  settings: AxisFormat = {},
  options: { vertical?: boolean; gridlines?: boolean } = {},
) {
  const min = settings.min !== undefined ? displayNumber(settings.min) : null;
  const max = settings.max !== undefined ? displayNumber(settings.max) : null;
  return {
    type: settings.log ? ("log" as const) : ("value" as const),
    position,
    ...(settings.title
      ? {
          name: settings.title,
          nameLocation: "middle" as const,
          nameGap: options.vertical === false ? 28 : 52,
          nameTextStyle: { color: theme.mutedText },
        }
      : {}),
    ...(min !== null ? { min } : {}),
    ...(max !== null ? { max } : {}),
    // Start at zero unless it was turned off (a log scale can't).
    ...(settings.zero === false || settings.log ? { scale: true } : {}),
    axisLabel: { color: theme.mutedText, formatter: format, hideOverlap: true },
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    splitLine: { show: settings.gridlines ?? options.gridlines ?? true, lineStyle: { color: theme.grid } },
  };
}

/** The colours for this chart's series (or groups), never repeated: a set too short for them falls back to the full eight. */
function chartColours(theme: ChartTheme, format: ChartFormat, count: number): string[] {
  const hue = (name: Hue) => theme.palette[HUES.indexOf(name) % theme.palette.length];
  const id = format.palette ?? "tohyee";
  if (id === "blues") {
    if (theme.blues?.length && count <= theme.blues.length) return theme.blues;
    return theme.palette;
  }
  return PALETTES[id].order.map(hue);
}

function hueColour(theme: ChartTheme, name: Hue | undefined): string | undefined {
  return name ? theme.palette[HUES.indexOf(name) % theme.palette.length] : undefined;
}

function legendPlacement(position: "top" | "bottom" | "right" | undefined) {
  if (position === "bottom") return { bottom: 0, left: "center" };
  if (position === "right") return { right: 0, top: "middle", orient: "vertical" as const };
  return { top: 0, left: "center" };
}

export function toEChartsOption(spec: ChartSpec, rows: ChartRow[], theme: ChartTheme): EChartsOption | KpiSummary {
  validateFields(spec, rows);
  if (spec.series.length === 0) throw new Error("A chart spec must include at least one series.");
  if (spec.kind === "kpi") return kpiSummary(spec, rows);

  const format = spec.format ?? {};
  const categories = formatCategories(rows.map((row) => row[spec.category]));
  const horizontal = spec.kind === "bar";
  const round = spec.kind === "pie" || spec.kind === "donut";
  const seriesFormat = (index: number) => format.series?.[index] ?? {};
  const placeOf = (index: number) => {
    const item = spec.series[index];
    const as = spec.kind === "combo" ? seriesFormat(index).as ?? item.as ?? "bar" : spec.kind === "line" || spec.kind === "area" ? "line" : "bar";
    const rightAllowed = spec.kind === "combo" || spec.kind === "line" || spec.kind === "area";
    const axis = rightAllowed ? seriesFormat(index).axis ?? item.axis ?? "left" : "left";
    return { as, axis };
  };
  const hasRightAxis = !round && spec.series.some((_item, index) => placeOf(index).axis === "right");
  const firstOn = (axis: "left" | "right") => Math.max(0, spec.series.findIndex((_item, index) => placeOf(index).axis === axis));
  const stack = format.stack ?? (spec.stacked ? "stacked" : "none");
  const stackable = spec.kind === "column" || spec.kind === "bar" || spec.kind === "area" || spec.kind === "combo";
  const stacking = stackable ? stack : "none";
  const colourByCategory = Boolean(format.colorByCategory) && (spec.kind === "column" || spec.kind === "bar") && spec.series.length === 1;
  const colours = chartColours(theme, format, colourByCategory ? rows.length : spec.series.length);
  const categoryColours = colourByCategory && rows.length <= colours.length;
  const seriesColour = (index: number) => hueColour(theme, seriesFormat(index).color) ?? colours[index % colours.length];
  const labels = format.labels ?? {};
  const legendShow = format.legend?.show ?? "auto";
  const showLegend =
    legendShow === "show" ||
    (legendShow === "auto" && (round ? labels.show === false : spec.series.length > 1 && !categoryColours));
  const legendPosition = format.legend?.position ?? "top";
  const fullFormatters = spec.series.map((_item, index) => seriesFormatter(spec, index));
  const labelFormatters = spec.series.map((_item, index) => seriesFormatter(spec, index, true));

  const legend = {
    show: showLegend,
    type: "scroll" as const,
    textStyle: { color: theme.mutedText },
    pageTextStyle: { color: theme.mutedText },
    ...legendPlacement(legendPosition),
  };
  const sameFormats = new Set(spec.series.map((_item, index) => JSON.stringify([seriesKind(spec, index), seriesNumber(spec, index) ?? null]))).size === 1;

  const common: EChartsOption = {
    // The card's own background shows through (plain, shaded or none).
    backgroundColor: "transparent",
    color: colours,
    textStyle: { color: theme.text },
    ...(spec.title ? { title: { text: spec.title, textStyle: { color: theme.text } } } : {}),
    legend,
    tooltip: {
      trigger: round ? ("item" as const) : ("axis" as const),
      valueFormatter: (value: unknown) =>
        fullFormatters[0](typeof value === "string" || typeof value === "number" ? value : String(value ?? "")),
      backgroundColor: theme.background,
      borderColor: theme.grid,
      textStyle: { color: theme.text },
    },
  };

  // Room for the legend and axis titles, only where they need it.
  const needsGrid = spec.compact || (showLegend && legendPosition !== "top") || format.valueAxis?.title || format.rightAxis?.title || format.categoryAxis?.title;
  if (!round && needsGrid) {
    const legendTop = showLegend && legendPosition === "top";
    common.grid = spec.compact
      ? { top: legendTop ? 32 : 8, bottom: showLegend && legendPosition === "bottom" ? 28 : 4, left: 4, right: showLegend && legendPosition === "right" ? 120 : 12 }
      : {
          top: legendTop ? 48 : 24,
          bottom: (showLegend && legendPosition === "bottom" ? 52 : 12) + ((horizontal ? format.valueAxis?.title : format.categoryAxis?.title) ? 28 : 0),
          left: 12 + ((horizontal ? format.categoryAxis?.title : format.valueAxis?.title) ? 28 : 0),
          right: (showLegend && legendPosition === "right" ? 140 : 16) + (format.rightAxis?.title && hasRightAxis ? 28 : 0),
        };
  }

  if (round) {
    const showLabels = labels.show !== false;
    const band = 70 / spec.series.length;
    const series = spec.series.map((item, index) => ({
      name: item.label,
      type: "pie" as const,
      radius: spec.kind === "donut" && spec.series.length === 1
        ? ["45%", "70%"]
        : spec.kind === "donut"
          ? [`${Math.round(45 + index * (25 / spec.series.length))}%`, `${Math.round(45 + (index + 1) * (25 / spec.series.length))}%`]
          : [`${Math.round(index * band)}%`, `${Math.round((index + 1) * band)}%`],
      ...(showLegend && legendPosition === "right" ? { center: ["40%", "50%"] } : {}),
      data: rows.flatMap((row, rowIndex) => {
        const value = displayNumber(row[item.field]);
        if (value === null) return [];
        const negative = format.negativeRed && theme.negative && value < 0;
        return [{ name: categories[rowIndex], value, ...(negative ? { itemStyle: { color: theme.negative } } : {}) }];
      }),
      avoidLabelOverlap: true,
      // A 2px gap in the surface colour between slices.
      itemStyle: { borderColor: theme.background, borderWidth: 2 },
      // Long names wrap rather than being cut off; the percentage shows the share.
      label: showLabels
        ? {
            show: true,
            color: theme.text,
            ...(labels.position === "inside" ? { position: "inside" as const } : {}),
            formatter: (params: { name?: string; value?: unknown; percent?: number }) =>
              labels.show
                ? `${params.name ?? ""}\n${fullFormatters[index](Number(params.value))} · ${params.percent ?? 0}%`
                : `${params.name ?? ""}\n${params.percent ?? 0}%`,
            width: 110,
            overflow: "break" as const,
            lineHeight: 15,
          }
        : { show: false },
      labelLine: { show: showLabels && labels.position !== "inside", length: 8, length2: 8 },
    }));
    const option: EChartsOption = { ...common, series };
    if (spec.kind === "donut" && format.donutTotal && spec.series.length === 1) {
      const values = rows.map((row) => row[spec.series[0].field]).filter((value): value is string | number => value !== null && value !== undefined);
      const total = toPlainString(sum(values.map((value) => dec(String(value)))));
      // Two centred lines in a group, which ECharts centres in the hole.
      option.graphic = [
        {
          type: "group",
          left: "center",
          top: "middle",
          ...(showLegend && legendPosition === "right" ? { left: "35%" } : {}),
          children: [
            { type: "text", x: 0, y: 0, style: { text: fullFormatters[0](total), fill: theme.text, font: "600 16px system-ui, sans-serif", align: "center" } },
            { type: "text", x: 0, y: 22, style: { text: "Total", fill: theme.mutedText, font: "13px system-ui, sans-serif", align: "center" } },
          ],
        },
      ];
    }
    return option;
  }

  // 100% stacked: each column shows its share of the group's total (positions only; the tooltip gives the amounts).
  const shares = stacking === "percent"
    ? rows.map((row) => {
        const values = spec.series.map((item, index) => (placeOf(index).as === "bar" || spec.kind === "area" ? displayNumber(row[item.field]) ?? 0 : 0));
        const total = values.reduce((runningTotal, value) => runningTotal + Math.abs(value), 0);
        return values.map((value) => (total === 0 ? 0 : value / total));
      })
    : null;

  const series = spec.series.map((item, index) => {
    const { as, axis } = placeOf(index);
    const colour = seriesColour(index);
    const stacked = stacking !== "none" && (as === "bar" || spec.kind === "area");
    const values = rows.map((row, rowIndex) => (shares && stacked ? shares[rowIndex][index] : displayNumber(row[item.field])));
    const data = values.map((value, rowIndex) => {
      const negative = format.negativeRed && theme.negative && as === "bar" && value !== null && value < 0;
      const byCategory = categoryColours && as === "bar";
      if (!negative && !byCategory) return value;
      return { value, itemStyle: { color: negative ? theme.negative : colours[rowIndex] } };
    });
    const labelPosition = labels.position === "inside" || (stacked && labels.position !== "outside")
      ? "inside"
      : as === "line"
        ? "top"
        : horizontal
          ? "right"
          : "top";
    const percentLabel = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
    return {
      // With two axes, the legend says which values use the right one.
      name: hasRightAxis && axis === "right" ? `${item.label} (right axis)` : item.label,
      type: as,
      data,
      ...(stacked ? { stack: "total" } : {}),
      ...(spec.kind === "area" ? { areaStyle: {} } : {}),
      ...(as === "line"
        ? { smooth: format.smooth ?? false, showSymbol: format.markers ?? true, symbolSize: 8, lineStyle: { color: colour, width: 2 } }
        : { barMaxWidth: 48, itemStyle: { color: colour, ...(stacked ? {} : { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] }) } }),
      ...(as === "line" ? { itemStyle: { color: colour } } : {}),
      ...(hasRightAxis ? { yAxisIndex: axis === "right" ? 1 : 0 } : {}),
      ...(labels.show
        ? {
            label: {
              show: true,
              position: labelPosition,
              color: theme.text,
              formatter: (params: { value?: unknown; data?: unknown }) => {
                const raw = params.value as number | null | undefined;
                if (raw === null || raw === undefined) return "";
                return shares && stacked ? percentLabel(raw) : labelFormatters[index](raw);
              },
            },
          }
        : {}),
    };
  });
  // With different number formats (or shares), each line of the tooltip uses its own value's format.
  if (!sameFormats || shares) {
    (common.tooltip as Record<string, unknown>).formatter = (params: unknown) => {
      const list = (Array.isArray(params) ? params : [params]) as Array<{ seriesIndex?: number; dataIndex?: number; marker?: unknown; seriesName?: string; axisValueLabel?: string }>;
      const heading = list[0]?.axisValueLabel ?? "";
      const lines = list.map((entry) => {
        const index = entry.seriesIndex ?? 0;
        const raw = rows[entry.dataIndex ?? 0]?.[spec.series[index]?.field ?? ""] ?? null;
        const shown = raw === null ? "—" : fullFormatters[index](raw);
        const share = shares && series[index]?.stack ? ` (${makeNumberFormatter({ style: "percent", decimals: 1 }, "number")(shares[entry.dataIndex ?? 0][index])})` : "";
        return `${typeof entry.marker === "string" ? entry.marker : ""}${escapeHtml(entry.seriesName ?? "")}: <b>${escapeHtml(shown)}</b>${share}`;
      });
      return [escapeHtml(heading), ...lines].join("<br/>");
    };
  }

  const categoryAxis = {
    type: "category" as const,
    data: categories,
    ...(format.categoryAxis?.title
      ? { name: format.categoryAxis.title, nameLocation: "middle" as const, nameGap: horizontal ? 52 : 32, nameTextStyle: { color: theme.mutedText } }
      : {}),
    axisLabel: { color: theme.mutedText },
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    splitLine: { show: format.categoryAxis?.gridlines ?? false, lineStyle: { color: theme.grid } },
  };
  const percentAxis = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
  const leftFormatter = shares ? (value: number | string) => percentAxis(value) : seriesFormatter(spec, firstOn("left"), true);
  const leftSettings: AxisFormat = shares ? { ...format.valueAxis, log: false, max: "1", min: undefined } : format.valueAxis ?? {};
  const leftAxis = numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: !horizontal });
  return {
    ...common,
    xAxis: horizontal ? numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: false }) : categoryAxis,
    yAxis: horizontal
      ? { ...categoryAxis, data: categories, inverse: true }
      : hasRightAxis
        ? [leftAxis, numberAxis(seriesFormatter(spec, firstOn("right"), true), theme, "right", format.rightAxis, { gridlines: false })]
        : [leftAxis],
    // Each entry is a bar or line series; TypeScript can't narrow the mixed list.
    series: series as EChartsOption["series"],
  };
}
