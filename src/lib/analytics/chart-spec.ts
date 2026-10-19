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
import { barRadius, echartsBase, MARKS, tooltipHtml, type ChartTheme, type TooltipRow } from "@/lib/charts/theme";
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

export type { ChartTheme };

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

type AxisOptions = { vertical?: boolean; gridlines?: boolean; compact?: boolean };

function numberAxis(
  format: (value: number | string) => string,
  theme: ChartTheme,
  position: "left" | "right" = "left",
  settings: AxisFormat = {},
  options: AxisOptions = {},
) {
  const base = echartsBase(theme);
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
          nameTextStyle: base.axisName,
        }
      : {}),
    ...(min !== null ? { min } : {}),
    ...(max !== null ? { max } : {}),
    // Start at zero unless it was turned off (a log scale can't).
    ...(settings.zero === false || settings.log ? { scale: true } : {}),
    // A small chart gets fewer, rounder steps so its labels don't crowd.
    ...(options.compact ? { splitNumber: 3 } : {}),
    axisLabel: { ...base.valueAxis.axisLabel, formatter: format, hideOverlap: true },
    axisLine: base.valueAxis.axisLine,
    axisTick: base.valueAxis.axisTick,
    splitLine: { show: settings.gridlines ?? options.gridlines ?? true, lineStyle: base.valueAxis.splitLine.lineStyle },
  };
}

/** The colours for this chart's series (or groups), never repeated: a set too short for them falls back to the full eight. */
export function chartColours(theme: ChartTheme, format: ChartFormat, count: number): string[] {
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

/** White or dark ink, whichever reads on a coloured fill (for labels inside columns and slices). */
export function inkOn(fill: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(fill.trim());
  if (!match) return "#ffffff";
  const channel = (offset: number) => {
    const value = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Whichever of white (1.0) and near-black (#0b1018) has more contrast.
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.0555) ? "#ffffff" : "#0b1018";
}

function legendPlacement(position: "top" | "bottom" | "right" | undefined) {
  if (position === "bottom") return { bottom: 0, left: "center" };
  if (position === "right") return { right: 0, top: "middle", orient: "vertical" as const };
  return { top: 0, left: "center" };
}

type TooltipEntry = { seriesIndex?: number; dataIndex?: number; color?: unknown; seriesName?: string; axisValueLabel?: string; name?: string; value?: unknown; percent?: number };

export function toEChartsOption(spec: ChartSpec, rows: ChartRow[], theme: ChartTheme): EChartsOption | KpiSummary {
  validateFields(spec, rows);
  if (spec.series.length === 0) throw new Error("A chart spec must include at least one series.");
  if (spec.kind === "kpi") return kpiSummary(spec, rows);

  const base = echartsBase(theme);
  const secondaryText = theme.secondaryText ?? theme.text;
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
  // A colour saved for a value (#333) always wins over the colour set.
  const seriesColour = (index: number) => hueColour(theme, seriesFormat(index).color) ?? colours[index % colours.length];
  const labels = format.labels ?? {};
  const legendShow = format.legend?.show ?? "auto";
  // A legend only when there's more than one thing to tell apart; one series is named by the title.
  const showLegend =
    legendShow === "show" ||
    (legendShow === "auto" && (round ? labels.show === false : spec.series.length > 1 && !categoryColours));
  const legendPosition = format.legend?.position ?? "top";
  const fullFormatters = spec.series.map((_item, index) => seriesFormatter(spec, index));
  const labelFormatters = spec.series.map((_item, index) => seriesFormatter(spec, index, true));
  const compact = Boolean(spec.compact);

  const legend = {
    ...base.legend,
    show: showLegend,
    type: "scroll" as const,
    ...legendPlacement(legendPosition),
  };

  const lineOnly = spec.kind === "line" || spec.kind === "area";
  const common: EChartsOption = {
    // The card's own background shows through (plain, shaded or none).
    backgroundColor: base.backgroundColor,
    color: colours,
    textStyle: base.textStyle,
    ...(spec.title ? { title: { text: spec.title, textStyle: { color: theme.text, fontSize: 14, fontWeight: 600 } } } : {}),
    legend,
    tooltip: {
      ...base.tooltip,
      trigger: round ? ("item" as const) : ("axis" as const),
      ...(round ? {} : { axisPointer: lineOnly ? base.linePointer : base.barPointer }),
      valueFormatter: (value: unknown) =>
        fullFormatters[0](typeof value === "string" || typeof value === "number" ? value : String(value ?? "")),
    },
  };

  if (round) {
    const showLabels = labels.show !== false;
    // Labels outside the slices need room at the sides, so the circle is a little smaller.
    const outer = showLabels && labels.position !== "inside" ? 62 : 70;
    const inner = Math.round(outer * 0.64);
    const band = outer / spec.series.length;
    const series = spec.series.map((item, index) => ({
      name: item.label,
      type: "pie" as const,
      radius: spec.kind === "donut" && spec.series.length === 1
        ? [`${inner}%`, `${outer}%`]
        : spec.kind === "donut"
          ? [`${Math.round(inner + index * ((outer - inner) / spec.series.length))}%`, `${Math.round(inner + (index + 1) * ((outer - inner) / spec.series.length))}%`]
          : [`${Math.round(index * band)}%`, `${Math.round((index + 1) * band)}%`],
      ...(showLegend && legendPosition === "right" ? { center: ["40%", "50%"] } : {}),
      data: rows.flatMap((row, rowIndex) => {
        const value = displayNumber(row[item.field]);
        if (value === null) return [];
        const negative = format.negativeRed && theme.negative && value < 0;
        return [{ name: categories[rowIndex], value, ...(negative ? { itemStyle: { color: theme.negative } } : {}) }];
      }),
      avoidLabelOverlap: true,
      // A 2px gap in the surface colour between slices, with softened corners.
      itemStyle: { borderColor: theme.background, borderWidth: MARKS.gap, borderRadius: 3 },
      emphasis: { scale: true, scaleSize: 4 },
      // Long names wrap rather than being cut off; the percentage shows the share.
      label: showLabels
        ? {
            show: true,
            color: labels.position === "inside" ? "#ffffff" : secondaryText,
            fontSize: 12,
            ...(labels.position === "inside" ? { position: "inside" as const } : {}),
            formatter: (params: { name?: string; value?: unknown; percent?: number }) =>
              labels.show
                ? `${params.name ?? ""}\n${fullFormatters[index](Number(params.value))} · ${params.percent ?? 0}%`
                : `${params.name ?? ""}\n${params.percent ?? 0}%`,
            // Kept to the card's edges and wrapped, so a long name is never cut off.
            ...(labels.position === "inside" ? {} : { alignTo: "edge" as const, edgeDistance: 4 }),
            width: 96,
            overflow: "break" as const,
            lineHeight: 15,
          }
        : { show: false },
      labelLine: { show: showLabels && labels.position !== "inside", length: 8, length2: 8, lineStyle: { color: theme.axis ?? theme.grid } },
    }));
    (common.tooltip as Record<string, unknown>).formatter = (params: unknown) => {
      const entry = (Array.isArray(params) ? params[0] : params) as TooltipEntry;
      const index = entry.seriesIndex ?? 0;
      const value = typeof entry.value === "number" ? fullFormatters[index](entry.value) : "—";
      const row: TooltipRow = { colour: typeof entry.color === "string" ? entry.color : colours[0], name: entry.name ?? "", value, note: `${entry.percent ?? 0}%` };
      return tooltipHtml(theme, spec.series.length > 1 ? entry.seriesName ?? "" : "", [row]);
    };
    const option: EChartsOption = { ...common, series };
    if (spec.kind === "donut" && format.donutTotal && spec.series.length === 1) {
      const values = rows.map((row) => row[spec.series[0].field]).filter((value): value is string | number => value !== null && value !== undefined);
      const total = toPlainString(sum(values.map((value) => dec(String(value)))));
      const font = base.textStyle.fontFamily;
      // Two centred lines in a group, which ECharts centres in the hole.
      option.graphic = [
        {
          type: "group",
          left: "center",
          top: "middle",
          ...(showLegend && legendPosition === "right" ? { left: "35%" } : {}),
          children: [
            { type: "text", x: 0, y: 0, style: { text: fullFormatters[0](total), fill: theme.text, font: `600 16px ${font}`, align: "center" } },
            { type: "text", x: 0, y: 22, style: { text: "Total", fill: theme.mutedText, font: `12px ${font}`, align: "center" } },
          ],
        },
      ];
    }
    return option;
  }

  // Room for the legend; the axis labels and titles are kept inside the card by ECharts itself.
  const legendTop = showLegend && legendPosition === "top";
  const legendBottom = showLegend && legendPosition === "bottom";
  const legendRight = showLegend && legendPosition === "right";
  common.grid = {
    top: legendTop ? (compact ? 32 : 40) : compact ? 8 : 16,
    bottom: legendBottom ? (compact ? 28 : 36) : 4,
    left: 4,
    right: legendRight ? (compact ? 120 : 140) : compact ? 8 : 16,
    outerBoundsMode: "same",
    outerBoundsContain: "all",
  };

  // 100% stacked: each column shows its share of the group's total (positions only; the tooltip gives the amounts).
  const shares = stacking === "percent"
    ? rows.map((row) => {
        const values = spec.series.map((item, index) => (placeOf(index).as === "bar" || spec.kind === "area" ? displayNumber(row[item.field]) ?? 0 : 0));
        const total = values.reduce((runningTotal, value) => runningTotal + Math.abs(value), 0);
        return values.map((value) => (total === 0 ? 0 : value / total));
      })
    : null;

  const isStacked = (index: number) => stacking !== "none" && (placeOf(index).as === "bar" || spec.kind === "area");
  const valueAt = (index: number, rowIndex: number) => {
    const raw = displayNumber(rows[rowIndex][spec.series[index].field]);
    return shares && isStacked(index) ? shares[rowIndex][index] : raw;
  };
  // In a stack, only the outermost segment (on each side of zero) gets the rounded end.
  const stackEnds = rows.map((_row, rowIndex) => {
    let top = -1;
    let bottom = -1;
    spec.series.forEach((_item, index) => {
      if (!isStacked(index) || placeOf(index).as !== "bar") return;
      const value = valueAt(index, rowIndex);
      if (value !== null && value > 0) top = index;
      if (value !== null && value < 0) bottom = index;
    });
    return { top, bottom };
  });

  const series = spec.series.map((item, index) => {
    const { as, axis } = placeOf(index);
    const colour = seriesColour(index);
    const stacked = isStacked(index);
    const values = rows.map((_row, rowIndex) => valueAt(index, rowIndex));
    const data = values.map((value, rowIndex) => {
      if (as !== "bar") return value;
      const negative = value !== null && value < 0;
      const red = format.negativeRed && theme.negative && negative;
      const byCategory = categoryColours;
      const end = stacked ? (negative ? stackEnds[rowIndex].bottom === index : stackEnds[rowIndex].top === index) : negative;
      if (!red && !byCategory && !end) return value;
      return {
        value,
        itemStyle: {
          ...(red || byCategory ? { color: red ? theme.negative : colours[rowIndex] } : {}),
          ...(end ? { borderRadius: barRadius(horizontal, negative) } : {}),
        },
      };
    });
    const insideLabels = labels.position === "inside" || (stacked && labels.position !== "outside");
    const labelPosition = insideLabels
      ? "inside"
      : as === "line"
        ? "top"
        : horizontal
          ? "right"
          : "top";
    const percentLabel = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
    const line = {
      smooth: format.smooth ?? false,
      // Dots on every point only when there are few enough to read (on a small pinned chart, only for a few points, so one point still shows); they show on hover either way.
      showSymbol: format.markers ?? rows.length <= (compact ? 3 : 12),
      symbol: "circle",
      // 8px across, with a 2px ring in the surface colour so it stands off the line.
      symbolSize: MARKS.symbolSize + MARKS.ringWidth,
      lineStyle: { color: colour, width: MARKS.lineWidth, cap: "round" as const, join: "round" as const },
      itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.ringWidth },
      emphasis: { scale: 1.2, lineStyle: { width: MARKS.lineWidth } },
    };
    const bar = {
      barMaxWidth: compact ? 16 : MARKS.barMaxWidth,
      barGap: "20%",
      barCategoryGap: "40%",
      itemStyle: {
        color: colour,
        ...(stacked
          ? // A 2px gap in the surface colour between stacked segments.
            { borderColor: theme.background, borderWidth: MARKS.gap / 2 }
          : { borderRadius: barRadius(horizontal, false) }),
      },
    };
    return {
      // With two axes, the legend says which values use the right one.
      name: hasRightAxis && axis === "right" ? `${item.label} (right axis)` : item.label,
      type: as,
      data,
      ...(stacked ? { stack: "total" } : {}),
      ...(spec.kind === "area" ? { areaStyle: { color: colour, opacity: stacked ? MARKS.stackedAreaOpacity : MARKS.areaOpacity } } : {}),
      ...(as === "line" ? line : bar),
      ...(hasRightAxis ? { yAxisIndex: axis === "right" ? 1 : 0 } : {}),
      ...(labels.show
        ? {
            label: {
              show: true,
              position: labelPosition,
              // Text wears text colours; inside a fill, white or dark ink, whichever reads.
              color: insideLabels && as === "bar" ? inkOn(colour) : secondaryText,
              fontSize: 12,
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

  // Every value in its own format, keyed by a short mark in its colour (a line for lines).
  (common.tooltip as Record<string, unknown>).formatter = (params: unknown) => {
    const list = (Array.isArray(params) ? params : [params]) as TooltipEntry[];
    const heading = list[0]?.axisValueLabel ?? "";
    const tooltipRows = list.map((entry): TooltipRow => {
      const index = entry.seriesIndex ?? 0;
      const raw = rows[entry.dataIndex ?? 0]?.[spec.series[index]?.field ?? ""] ?? null;
      const shown = raw === null ? "—" : fullFormatters[index](raw);
      const share = shares && series[index]?.stack ? makeNumberFormatter({ style: "percent", decimals: 1 }, "number")(shares[entry.dataIndex ?? 0][index]) : undefined;
      return {
        colour: typeof entry.color === "string" ? entry.color : seriesColour(index),
        name: entry.seriesName ?? "",
        value: shown,
        ...(share ? { note: `(${share})` } : {}),
        line: placeOf(index).as === "line",
      };
    });
    return tooltipHtml(theme, heading, tooltipRows);
  };

  const categoryAxis = {
    type: "category" as const,
    data: categories,
    ...(format.categoryAxis?.title
      ? { name: format.categoryAxis.title, nameLocation: "middle" as const, nameGap: horizontal ? 52 : 32, nameTextStyle: base.axisName }
      : {}),
    axisLabel: {
      ...base.categoryAxis.axisLabel,
      // Long names on bars are shortened (the tooltip and table have them in full).
      ...(horizontal ? { width: compact ? 88 : 140, overflow: "truncate" as const } : {}),
    },
    axisLine: base.categoryAxis.axisLine,
    axisTick: base.categoryAxis.axisTick,
    splitLine: { show: format.categoryAxis?.gridlines ?? false, lineStyle: base.categoryAxis.splitLine.lineStyle },
  };
  const percentAxis = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
  const leftFormatter = shares ? (value: number | string) => percentAxis(value) : seriesFormatter(spec, firstOn("left"), true);
  const leftSettings: AxisFormat = shares ? { ...format.valueAxis, log: false, max: "1", min: undefined } : format.valueAxis ?? {};
  const leftAxis = numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: !horizontal, compact });
  return {
    ...common,
    xAxis: horizontal ? numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: false, compact }) : categoryAxis,
    yAxis: horizontal
      ? { ...categoryAxis, data: categories, inverse: true }
      : hasRightAxis
        ? [leftAxis, numberAxis(seriesFormatter(spec, firstOn("right"), true), theme, "right", format.rightAxis, { gridlines: false, compact })]
        : [leftAxis],
    // Each entry is a bar or line series; TypeScript can't narrow the mixed list.
    series: series as EChartsOption["series"],
  };
}
