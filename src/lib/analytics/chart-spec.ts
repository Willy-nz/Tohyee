import type { EChartsOption } from "echarts";
import {
  HUES,
  PALETTES,
  makeNumberFormatter,
  type AxisFormat,
  type CardFormat,
  type ChartFormat,
  type Hue,
  type LegendPosition,
  type NumberFormat,
  type ReferenceLine,
  type SeriesFormat,
  type ValueKind,
} from "@/lib/analytics/chart-format";
import { barRadius, echartsBase, MARKS, tooltipHtml, type ChartTheme, type TooltipRow } from "@/lib/charts/theme";
import { adaptForDark, isDarkSurface } from "@/lib/charts/colour-check";
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

/** The groups as a chart names them (dates as "Jan 2026"), for choosing a group's colour (#376). */
export function chartGroupNames(values: unknown[]): string[] {
  return formatCategories(values);
}

/** Whether the groups are all dates (so the axis can be limited to a date range). */
export function datedGroups(values: unknown[]): boolean {
  return values.length > 0 && values.every(isoDate);
}

type AxisOptions = { vertical?: boolean; gridlines?: boolean; compact?: boolean; lineStyle?: GridLineStyle };
type GridLineStyle = { color: string; width: number; type: "solid" | "dashed" | "dotted" };

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
    // How it looks (#376): hidden, its step, reversed, and its labels' size, colour and angle.
    ...(settings.show === false ? { show: false } : {}),
    ...(settings.step !== undefined && !settings.log ? { interval: displayNumber(settings.step) ?? undefined } : {}),
    ...(settings.reverse ? { inverse: true } : {}),
    axisLabel: {
      ...base.valueAxis.axisLabel,
      ...(settings.size ? { fontSize: settings.size } : {}),
      ...(settings.color ? { color: settings.color } : {}),
      ...(settings.rotate !== undefined ? { rotate: settings.rotate } : {}),
      formatter: format,
      hideOverlap: true,
    },
    axisLine: base.valueAxis.axisLine,
    axisTick: base.valueAxis.axisTick,
    splitLine: { show: settings.gridlines ?? options.gridlines ?? true, lineStyle: options.lineStyle ?? base.valueAxis.splitLine.lineStyle },
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
  // A report theme (decision 668) can have up to 12 colours: the first eight follow the chosen order, the rest come after.
  if (id === "tohyee") return theme.palette;
  return [...PALETTES[id].order.map(hue), ...theme.palette.slice(HUES.length)];
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

/** Where the legend sits, and its title just above it (#376: every side and corner). */
function legendPlacement(position: LegendPosition, titled: boolean) {
  const shift = titled ? 20 : 0;
  const vertical = position === "left" || position === "right";
  const [edge, along] = position.includes("-") ? (position.split("-") as ["top" | "bottom", "left" | "right"]) : [position, null];
  if (vertical) {
    const side = { [position]: 0 } as Record<string, number>;
    return { legend: { ...side, top: titled ? 24 : "middle", orient: "vertical" as const }, title: { ...side, top: 0 } };
  }
  const horizontal = along ? { [along]: 0 } : { left: "center" };
  if (edge === "bottom") return { legend: { bottom: 0, ...horizontal }, title: { bottom: 22, ...horizontal }, shift };
  return { legend: { top: shift, ...horizontal }, title: { top: 0, ...horizontal } };
}

type TooltipEntry = { seriesIndex?: number; dataIndex?: number; color?: unknown; seriesName?: string; axisValueLabel?: string; name?: string; value?: unknown; percent?: number };

/** A reference line's value from the values drawn (display numbers; #376). Percentiles interpolate, like a spreadsheet's PERCENTILE.INC. */
export function referenceValue(line: Pick<ReferenceLine, "kind" | "value" | "percentile">, values: number[]): number | null {
  if (line.kind === "constant" || line.kind === "target" || line.kind === "band") return line.value === undefined ? null : displayNumber(line.value);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (line.kind === "min") return sorted[0];
  if (line.kind === "max") return sorted[sorted.length - 1];
  if (line.kind === "average") return values.reduce((total, value) => total + value, 0) / values.length;
  const share = line.kind === "median" ? 0.5 : (line.percentile ?? 50) / 100;
  const rank = share * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

const tidy = (value: number) => Math.round(value * 1e9) / 1e9;

/** A straight line through the values (least squares, by position), carried on `extra` places: the trend and a simple forecast. */
export function trendLine(values: Array<number | null>, extra: number): Array<number | null> {
  const points = values.flatMap((value, index) => (value === null ? [] : [[index, value] as const]));
  if (points.length < 2) return [...values, ...Array<null>(extra).fill(null)];
  const n = points.length;
  const meanX = points.reduce((total, [x]) => total + x, 0) / n;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / n;
  const slope = points.reduce((total, [x, y]) => total + (x - meanX) * (y - meanY), 0) / points.reduce((total, [x]) => total + (x - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  return Array.from({ length: values.length + extra }, (_unused, index) => tidy(intercept + slope * index));
}

/** The next groups after the last one, for a forecast: months or days on from dates, otherwise "+1", "+2"... */
function nextCategories(values: unknown[], count: number): unknown[] {
  if (count === 0) return [];
  const dates = values.length >= 2 && values.every(isoDate) ? (values as string[]) : null;
  if (!dates) return Array.from({ length: count }, (_unused, index) => `+${index + 1}`);
  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const before = new Date(`${dates[dates.length - 2]}T00:00:00Z`);
  const monthly = dates.every((value) => value.endsWith("-01"));
  const step = monthly
    ? (last.getUTCFullYear() - before.getUTCFullYear()) * 12 + last.getUTCMonth() - before.getUTCMonth()
    : Math.round((last.getTime() - before.getTime()) / 86400000);
  return Array.from({ length: count }, (_unused, index) => {
    const next = new Date(last);
    if (monthly) next.setUTCMonth(next.getUTCMonth() + step * (index + 1));
    else next.setUTCDate(next.getUTCDate() + step * (index + 1));
    return next.toISOString().slice(0, 10);
  });
}

const REFERENCE_NAMES: Record<ReferenceLine["kind"], string> = {
  constant: "",
  target: "Target",
  average: "Average",
  median: "Median",
  min: "Lowest",
  max: "Highest",
  percentile: "Percentile",
  band: "",
};

function ordinal(number: number): string {
  const tens = number % 100;
  if (tens >= 11 && tens <= 13) return `${number}th`;
  return `${number}${["th", "st", "nd", "rd"][number % 10] ?? "th"}`;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const CARD_SHADOWS = {
  none: "none",
  soft: "0 1px 2px rgba(15, 23, 35, 0.06), 0 4px 12px rgba(15, 23, 35, 0.06)",
  strong: "0 2px 4px rgba(15, 23, 35, 0.12), 0 8px 24px rgba(15, 23, 35, 0.16)",
} as const;

type Css = Record<string, string | number>;

/**
 * A tile's card, title and subtitle as inline styles (#376). Everything was
 * checked by parseChartFormat (hex colours, whole numbers), so it's safe to
 * put on the page. Left out, the card keeps the theme's look.
 */
export function cardStyle(format: ChartFormat | undefined): { card: Css; title: Css; subtitle: Css } {
  const card = format?.card ?? {};
  const style: { card: Css; title: Css; subtitle: Css } = { card: {}, title: {}, subtitle: {} };
  const text = (target: Css, value: CardFormat["subtitleStyle"]) => {
    if (!value) return;
    if (value.size !== undefined) target.fontSize = `${value.size}px`;
    if (value.bold !== undefined) target.fontWeight = value.bold ? 700 : 400;
    if (value.italic) target.fontStyle = "italic";
    if (value.color) target.color = value.color;
    if (value.align) target.textAlign = value.align;
  };
  // One colour for both modes, with its dark version worked out (decision 672), for CSS's light-dark().
  const both = (hex: string, role: "mark" | "surface" | "text", alpha = 1) => {
    const dark = adaptForDark(hex, role);
    return alpha === 1 ? `light-dark(${hex}, ${dark})` : `light-dark(${rgba(hex, alpha)}, ${rgba(dark, alpha)})`;
  };
  text(style.title, card.title);
  if (card.title?.color) style.title.color = both(card.title.color, "text");
  if (card.title?.background) Object.assign(style.title, { background: both(card.title.background, "surface"), padding: "2px 6px", borderRadius: "4px" });
  text(style.subtitle, card.subtitleStyle);
  if (card.subtitleStyle?.color) style.subtitle.color = both(card.subtitleStyle.color, "text");
  const opacity = card.opacity ?? 100;
  if (card.fill) style.card.background = both(card.fill, "surface", opacity / 100);
  else if (card.opacity !== undefined) style.card.background = `color-mix(in srgb, var(--report-card, var(--surface)) ${opacity}%, transparent)`;
  if (card.borderColor) style.card.borderColor = both(card.borderColor, "mark");
  if (card.borderWidth !== undefined) {
    style.card.borderWidth = `${card.borderWidth}px`;
    style.card.borderStyle = "solid";
  }
  if (card.radius !== undefined) style.card.borderRadius = `${card.radius}px`;
  if (card.shadow) style.card.boxShadow = CARD_SHADOWS[card.shadow];
  if (card.padding !== undefined) style.card.padding = `${card.padding}px`;
  return style;
}

/**
 * The format with its chosen colours as they're drawn on this card: on a
 * dark card each gets its dark version (decision 672); on a light one
 * they're as chosen.
 */
function forMode(format: ChartFormat, theme: ChartTheme): ChartFormat {
  if (!isDarkSurface(theme.background)) return format;
  const mark = (hex: string | undefined) => (hex ? adaptForDark(hex, "mark", theme.background) : hex);
  const text = (hex: string | undefined) => (hex ? adaptForDark(hex, "text", theme.background) : hex);
  const surface = (hex: string | undefined) => (hex ? adaptForDark(hex, "surface", theme.background) : hex);
  const axis = <T extends { color?: string }>(value: T | undefined) => (value?.color ? { ...value, color: text(value.color) } : value);
  return {
    ...format,
    ...(format.series ? { series: format.series.map((series) => (series.hex ? { ...series, hex: mark(series.hex) } : series)) } : {}),
    ...(format.categoryColors ? { categoryColors: format.categoryColors.map((entry) => ({ ...entry, color: mark(entry.color)! })) } : {}),
    ...(format.labels?.color ? { labels: { ...format.labels, color: text(format.labels.color) } } : {}),
    ...(format.categoryAxis ? { categoryAxis: axis(format.categoryAxis) } : {}),
    ...(format.valueAxis ? { valueAxis: axis(format.valueAxis) } : {}),
    ...(format.rightAxis ? { rightAxis: axis(format.rightAxis) } : {}),
    ...(format.gridlines?.color ? { gridlines: { ...format.gridlines, color: surface(format.gridlines.color) } } : {}),
    ...(format.plot?.background ? { plot: { background: surface(format.plot.background) } } : {}),
    ...(format.referenceLines ? { referenceLines: format.referenceLines.map((line) => (line.color ? { ...line, color: mark(line.color) } : line)) } : {}),
  };
}

export function toEChartsOption(spec: ChartSpec, allRows: ChartRow[], theme: ChartTheme): EChartsOption | KpiSummary {
  validateFields(spec, allRows);
  if (spec.series.length === 0) throw new Error("A chart spec must include at least one series.");
  if (spec.kind === "kpi") return kpiSummary(spec, allRows);

  const base = echartsBase(theme);
  const secondaryText = theme.secondaryText ?? theme.text;
  const format = forMode(spec.format ?? {}, theme);
  // Only the dates asked for, when the groups are dates (#376).
  const from = format.categoryAxis?.from;
  const to = format.categoryAxis?.to;
  const dated = allRows.length > 0 && allRows.every((row) => isoDate(row[spec.category]));
  const rows = dated && (from || to)
    ? allRows.filter((row) => {
        const value = row[spec.category] as string;
        return (!from || value >= from) && (!to || value <= to);
      })
    : allRows;
  const horizontal = spec.kind === "bar";
  const round = spec.kind === "pie" || spec.kind === "donut";
  const seriesFormat = (index: number): SeriesFormat => format.series?.[index] ?? {};
  // A forecast adds groups after the last one; the values themselves have nothing there.
  const forecastLength = round ? 0 : Math.max(0, ...spec.series.map((_item, index) => seriesFormat(index).forecast ?? 0));
  const categoryValues = [...rows.map((row) => row[spec.category]), ...nextCategories(rows.map((row) => row[spec.category]), forecastLength)];
  const categories = formatCategories(categoryValues);
  const placeOf = (index: number) => {
    const item = spec.series[index];
    const as = spec.kind === "combo" ? seriesFormat(index).as ?? item.as ?? "bar" : spec.kind === "line" || spec.kind === "area" ? "line" : "bar";
    const rightAllowed = spec.kind === "combo" || spec.kind === "line" || spec.kind === "area";
    const axis = rightAllowed ? seriesFormat(index).axis ?? item.axis ?? "left" : "left";
    return { as, axis };
  };
  // A value can be only in the tooltip: not drawn, so it doesn't stretch the axis (#376).
  const drawnIndexes = spec.series.map((_item, index) => index).filter((index) => seriesFormat(index).tooltip !== "only");
  const drawn = drawnIndexes.length ? drawnIndexes : [0];
  const isDrawn = (index: number) => drawn.includes(index);
  const hasRightAxis = !round && drawn.some((index) => placeOf(index).axis === "right");
  const firstOn = (axis: "left" | "right") => Math.max(0, drawn.find((index) => placeOf(index).axis === axis) ?? 0);
  const stack = format.stack ?? (spec.stacked ? "stacked" : "none");
  const stackable = spec.kind === "column" || spec.kind === "bar" || spec.kind === "area" || spec.kind === "combo";
  const stacking = stackable ? stack : "none";
  const colourByCategory = Boolean(format.colorByCategory) && (spec.kind === "column" || spec.kind === "bar") && drawn.length === 1;
  const colours = chartColours(theme, format, colourByCategory ? rows.length : spec.series.length);
  const categoryColours = colourByCategory && rows.length <= colours.length;
  // Colours chosen for named groups (any colour); the rest follow the theme.
  const namedColours = new Map((format.categoryColors ?? []).map((entry) => [entry.name, entry.color]));
  const groupColour = (rowIndex: number) => namedColours.get(categories[rowIndex]);
  const groupColours = namedColours.size > 0 && (round || drawn.length === 1);
  // A colour saved for a value always wins over the colour set: any hex first, then a named colour.
  const seriesColour = (index: number) => seriesFormat(index).hex ?? hueColour(theme, seriesFormat(index).color) ?? colours[index % colours.length];
  const labels = format.labels ?? {};
  const labelSize = labels.size ?? base.labelSize;
  const legendShow = format.legend?.show ?? "auto";
  // A legend only when there's more than one thing to tell apart; one series is named by the title.
  const showLegend =
    legendShow === "show" ||
    (legendShow === "auto" && (round ? labels.show === false : drawn.length > 1 && !categoryColours));
  const legendPosition = format.legend?.position ?? "top";
  const legendTitle = showLegend ? format.legend?.title : undefined;
  const placed = legendPlacement(legendPosition, Boolean(legendTitle));
  const fullFormatters = spec.series.map((_item, index) => seriesFormatter(spec, index));
  // Data labels can have their own number format, apart from the axis (#376).
  const labelFormatters = spec.series.map((_item, index) =>
    labels.number
      ? (value: number | string) => makeNumberFormatter(labels.number, seriesKind(spec, index), { currency: spec.currency })(value)
      : seriesFormatter(spec, index, true),
  );
  const compact = Boolean(spec.compact);
  const lastIndex = rows.length - 1;
  // "Ends": only the first and last label of each value.
  const labelShown = (dataIndex: number | undefined) => labels.density !== "ends" || dataIndex === 0 || dataIndex === lastIndex;

  const legend = {
    ...base.legend,
    textStyle: { ...base.legend.textStyle, ...(format.legend?.size ? { fontSize: format.legend.size } : {}) },
    show: showLegend,
    type: "scroll" as const,
    ...placed.legend,
    ...(round ? {} : { data: drawn.map((index) => (hasRightAxis && placeOf(index).axis === "right" ? `${spec.series[index].label} (right axis)` : spec.series[index].label)) }),
  };

  const titles: Array<Record<string, unknown>> = [];
  if (spec.title) titles.push({ text: spec.title, textStyle: { color: theme.text, fontSize: 14, fontWeight: 600 } });
  if (legendTitle) titles.push({ text: legendTitle, ...placed.title, textStyle: { color: theme.mutedText, fontSize: (format.legend?.size ?? base.labelSize) - 1, fontWeight: 600 } });

  const lineOnly = spec.kind === "line" || spec.kind === "area";
  const common: EChartsOption = {
    // The card's own background shows through (plain, shaded or none).
    backgroundColor: base.backgroundColor,
    color: colours,
    textStyle: base.textStyle,
    ...(titles.length ? { title: titles.length === 1 ? titles[0] : titles } : {}),
    legend,
    tooltip: {
      ...base.tooltip,
      ...(format.tooltip?.show === false ? { show: false } : {}),
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
    const content = {
      category: labels.content?.category ?? true,
      value: labels.content?.value ?? labels.show === true,
      percent: labels.content?.percent ?? true,
    };
    const series = spec.series.map((item, index) => ({
      name: item.label,
      type: "pie" as const,
      radius: spec.kind === "donut" && spec.series.length === 1
        ? [`${inner}%`, `${outer}%`]
        : spec.kind === "donut"
          ? [`${Math.round(inner + index * ((outer - inner) / spec.series.length))}%`, `${Math.round(inner + (index + 1) * ((outer - inner) / spec.series.length))}%`]
          : [`${Math.round(index * band)}%`, `${Math.round((index + 1) * band)}%`],
      ...(showLegend && legendPosition === "right" ? { center: ["40%", "50%"] } : showLegend && legendPosition === "left" ? { center: ["60%", "50%"] } : {}),
      data: rows.flatMap((row, rowIndex) => {
        const value = displayNumber(row[item.field]);
        if (value === null) return [];
        const negative = format.negativeRed && theme.negative && value < 0;
        const named = groupColour(rowIndex);
        const colour = negative ? theme.negative : named;
        return [{ name: categories[rowIndex], value, ...(colour ? { itemStyle: { color: colour } } : {}) }];
      }),
      avoidLabelOverlap: true,
      // A 2px gap in the surface colour between slices, with softened corners.
      itemStyle: { borderColor: theme.background, borderWidth: MARKS.gap, borderRadius: 3 },
      emphasis: { scale: true, scaleSize: 4 },
      // Long names wrap rather than being cut off; the percentage shows the share.
      label: showLabels
        ? {
            show: true,
            color: labels.color ?? (labels.position === "inside" ? "#ffffff" : secondaryText),
            fontSize: labelSize,
            ...(labels.position === "inside" ? { position: "inside" as const } : {}),
            formatter: (params: { name?: string; value?: unknown; percent?: number }) => {
              const figures = [
                content.value ? (labels.number ? labelFormatters[index] : fullFormatters[index])(Number(params.value)) : null,
                content.percent ? `${params.percent ?? 0}%` : null,
              ].filter(Boolean).join(" · ");
              return [content.category ? params.name ?? "" : null, figures || null].filter((part) => part !== null).join("\n");
            },
            // Kept to the card's edges and wrapped, so a long name is never cut off.
            ...(labels.position === "inside" ? {} : { alignTo: "edge" as const, edgeDistance: 4 }),
            width: 96,
            overflow: "break" as const,
            lineHeight: Math.round(labelSize * 1.25),
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
  const legendTop = showLegend && legendPosition.startsWith("top");
  const legendBottom = showLegend && legendPosition.startsWith("bottom");
  const legendRight = showLegend && legendPosition === "right";
  const legendLeft = showLegend && legendPosition === "left";
  const titleRoom = legendTitle && (legendTop || legendBottom) ? 20 : 0;
  common.grid = {
    top: (legendTop ? (compact ? 32 : 40) : compact ? 8 : 16) + (legendTop ? titleRoom : 0),
    bottom: (legendBottom ? (compact ? 28 : 36) : 4) + (legendBottom ? titleRoom : 0),
    left: legendLeft ? (compact ? 120 : 140) : 4,
    right: legendRight ? (compact ? 120 : 140) : compact ? 8 : 16,
    outerBoundsMode: "same",
    outerBoundsContain: "all",
    // A plot area colour (#376) behind the marks only.
    ...(format.plot?.background ? { show: true, backgroundColor: format.plot.background, borderWidth: 0 } : {}),
  };

  // 100% stacked: each column shows its share of the group's total (positions only; the tooltip gives the amounts).
  const shares = stacking === "percent"
    ? rows.map((row) => {
        const values = spec.series.map((item, index) => (isDrawn(index) && (placeOf(index).as === "bar" || spec.kind === "area") ? displayNumber(row[item.field]) ?? 0 : 0));
        const total = values.reduce((runningTotal, value) => runningTotal + Math.abs(value), 0);
        return values.map((value) => (total === 0 ? 0 : value / total));
      })
    : null;

  const isStacked = (index: number) => stacking !== "none" && isDrawn(index) && (placeOf(index).as === "bar" || spec.kind === "area");
  const valueAt = (index: number, rowIndex: number) => {
    const raw = displayNumber(rows[rowIndex][spec.series[index].field]);
    return shares && isStacked(index) ? shares[rowIndex][index] : raw;
  };
  const rounded = format.bars?.rounded !== false;
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

  const percentLabel = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
  const padding = Array<null>(forecastLength).fill(null);
  type Meta = { kind: "value" | "trend"; index: number };
  const meta: Meta[] = [];
  const series: Array<Record<string, unknown>> = drawn.map((index) => {
    meta.push({ kind: "value", index });
    const item = spec.series[index];
    const own = seriesFormat(index);
    const { as, axis } = placeOf(index);
    const colour = seriesColour(index);
    const stacked = isStacked(index);
    const values = rows.map((_row, rowIndex) => valueAt(index, rowIndex));
    const data = values.map((value, rowIndex) => {
      if (as !== "bar") return value;
      const negative = value !== null && value < 0;
      const red = format.negativeRed && theme.negative && negative;
      const named = groupColours ? groupColour(rowIndex) : undefined;
      const byCategory = categoryColours;
      const end = rounded && (stacked ? (negative ? stackEnds[rowIndex].bottom === index : stackEnds[rowIndex].top === index) : negative);
      if (!red && !byCategory && !end && !named) return value;
      return {
        value,
        itemStyle: {
          ...(red || named || byCategory ? { color: red ? theme.negative : named ?? colours[rowIndex] } : {}),
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
    const markers = own.markers ?? format.markers;
    const line = {
      smooth: format.smooth ?? false,
      ...(own.step ? { step: "middle" } : {}),
      // Dots on every point only when there are few enough to read (on a small pinned chart, only for a few points, so one point still shows); they show on hover either way.
      showSymbol: markers ?? rows.length <= (compact ? 3 : 12),
      symbol: "circle",
      // 8px across, with a 2px ring in the surface colour so it stands off the line.
      symbolSize: MARKS.symbolSize + MARKS.ringWidth,
      lineStyle: { color: colour, width: own.lineWidth ?? MARKS.lineWidth, type: own.lineStyle ?? "solid", cap: "round" as const, join: "round" as const },
      itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.ringWidth },
      emphasis: { scale: 1.2, lineStyle: { width: own.lineWidth ?? MARKS.lineWidth } },
    };
    const bar = {
      barMaxWidth: format.bars?.thickness ?? (compact ? 16 : MARKS.barMaxWidth),
      barGap: "20%",
      barCategoryGap: format.bars?.gap !== undefined ? `${format.bars.gap}%` : "40%",
      itemStyle: {
        color: colour,
        ...(stacked
          ? // A 2px gap in the surface colour between stacked segments.
            { borderColor: theme.background, borderWidth: MARKS.gap / 2 }
          : { borderRadius: rounded ? barRadius(horizontal, false) : 0 }),
      },
    };
    return {
      // With two axes, the legend says which values use the right one.
      name: hasRightAxis && axis === "right" ? `${item.label} (right axis)` : item.label,
      type: as,
      data: [...data, ...padding],
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
              color: labels.color ?? (insideLabels && as === "bar" ? inkOn(colour) : secondaryText),
              fontSize: labelSize,
              formatter: (params: { value?: unknown; dataIndex?: number }) => {
                const raw = params.value as number | null | undefined;
                if (raw === null || raw === undefined || !labelShown(params.dataIndex)) return "";
                return shares && stacked ? percentLabel(raw) : labelFormatters[index](raw);
              },
            },
            ...(labels.density === "auto" ? { labelLayout: { hideOverlap: true } } : {}),
          }
        : {}),
    };
  });

  // Trend lines and forecasts (#376): dashed, in the value's colour, on its axis.
  for (const index of drawn) {
    const own = seriesFormat(index);
    if (!own.trend && !own.forecast) continue;
    if (shares && isStacked(index)) continue;
    const values = rows.map((_row, rowIndex) => valueAt(index, rowIndex));
    const fitted = trendLine(values, own.forecast ?? 0);
    meta.push({ kind: "trend", index });
    series.push({
      name: `${spec.series[index].label} trend`,
      type: "line",
      data: [...fitted, ...Array<null>(forecastLength - (own.forecast ?? 0)).fill(null)],
      showSymbol: false,
      symbol: "none",
      lineStyle: { color: seriesColour(index), width: 2, type: "dashed" },
      itemStyle: { color: seriesColour(index) },
      ...(hasRightAxis ? { yAxisIndex: placeOf(index).axis === "right" ? 1 : 0 } : {}),
    });
  }

  // Reference lines and bands (#376), on the left (or bottom) value axis.
  const referenceLines = format.referenceLines ?? [];
  if (referenceLines.length) {
    const axisKey = horizontal ? "xAxis" : "yAxis";
    const lineData: Array<Record<string, unknown>> = [];
    const areaData: Array<Array<Record<string, unknown>>> = [];
    for (const line of referenceLines) {
      const index = Math.min(line.series ?? drawn[0], spec.series.length - 1);
      const values = rows.flatMap((_row, rowIndex) => {
        const value = valueAt(index, rowIndex);
        return value === null ? [] : [value];
      });
      const value = referenceValue(line, values);
      if (value === null) continue;
      const colour = line.color ?? theme.mutedText;
      const kindName = line.kind === "percentile" ? `${ordinal(line.percentile ?? 50)} percentile` : REFERENCE_NAMES[line.kind];
      const derived = ["average", "median", "min", "max", "percentile"].includes(line.kind);
      const name = line.label ?? (derived ? `${kindName} of ${spec.series[index].label}` : kindName);
      const shown = (number: number) => (shares ? percentLabel(number) : fullFormatters[index](number));
      if (line.kind === "band") {
        const end = displayNumber(line.to ?? null);
        if (end === null) continue;
        areaData.push([
          { [axisKey]: value, name, itemStyle: { color: rgba(line.color ?? "#8b94a1", 0.14) }, label: { color: secondaryText, fontSize: labelSize, position: horizontal ? "insideTop" : "insideLeft" } },
          { [axisKey]: end },
        ]);
        continue;
      }
      lineData.push({
        [axisKey]: value,
        name,
        lineStyle: { color: colour, type: line.style ?? "dashed", width: 1.5 },
        // On bars the groups read top down, so the line's start is at the top, clear of the axis labels.
        label: { color: secondaryText, fontSize: labelSize, position: horizontal ? (format.categoryAxis?.reverse ? "end" : "start") : "insideEndTop", formatter: name ? `${name}: ${shown(value)}` : shown(value) },
      });
    }
    series.push({
      name: "Reference lines",
      type: "line",
      data: [],
      silent: true,
      ...(hasRightAxis ? { yAxisIndex: 0 } : {}),
      markLine: { symbol: "none", silent: true, data: lineData },
      ...(areaData.length ? { markArea: { silent: true, data: areaData } } : {}),
    });
  }

  const hiddenFromTooltip = (index: number) => seriesFormat(index).tooltip === "hide";
  const onlyInTooltip = spec.series.map((_item, index) => index).filter((index) => !isDrawn(index));
  // Every value in its own format, keyed by a short mark in its colour (a line for lines).
  (common.tooltip as Record<string, unknown>).formatter = (params: unknown) => {
    const list = (Array.isArray(params) ? params : [params]) as TooltipEntry[];
    const heading = list[0]?.axisValueLabel ?? "";
    const dataIndex = list[0]?.dataIndex ?? 0;
    const row = rows[dataIndex];
    const tooltipRows: TooltipRow[] = [];
    const counted: Array<string | number> = [];
    for (const entry of list) {
      const info = meta[entry.seriesIndex ?? 0];
      if (!info) continue;
      const index = info.index;
      if (info.kind === "trend") {
        const value = typeof entry.value === "number" ? fullFormatters[index](entry.value) : "—";
        tooltipRows.push({ colour: seriesColour(index), name: entry.seriesName ?? "", value, line: true });
        continue;
      }
      if (hiddenFromTooltip(index)) continue;
      const raw = row?.[spec.series[index]?.field ?? ""] ?? null;
      if (raw !== null && raw !== undefined) counted.push(raw);
      const shown = raw === null || raw === undefined ? "—" : fullFormatters[index](raw);
      const share = shares && isStacked(index) && row ? makeNumberFormatter({ style: "percent", decimals: 1 }, "number")(shares[dataIndex][index]) : undefined;
      tooltipRows.push({
        colour: typeof entry.color === "string" ? entry.color : seriesColour(index),
        name: entry.seriesName ?? "",
        value: shown,
        ...(share ? { note: `(${share})` } : {}),
        line: placeOf(index).as === "line",
      });
    }
    if (row) {
      for (const index of onlyInTooltip) {
        const raw = row[spec.series[index].field] ?? null;
        if (raw !== null) counted.push(raw);
        tooltipRows.push({ colour: theme.mutedText, name: spec.series[index].label, value: raw === null ? "—" : fullFormatters[index](raw) });
      }
      // A total of the values shown, added exactly (#376).
      if (format.tooltip?.total && counted.length > 1) {
        const total = toPlainString(sum(counted.map((value) => dec(String(value)))));
        tooltipRows.push({ colour: "transparent", name: "Total", value: fullFormatters[drawn[0]](total) });
      }
    }
    return tooltipHtml(theme, heading, tooltipRows);
  };

  const gridLine = (fallback: GridLineStyle): GridLineStyle => ({
    ...fallback,
    ...(format.gridlines?.color ? { color: format.gridlines.color } : {}),
    ...(format.gridlines?.style ? { type: format.gridlines.style } : {}),
  });
  const categoryFormat = format.categoryAxis ?? {};
  const categoryAxis = {
    type: "category" as const,
    data: categories,
    ...(categoryFormat.show === false ? { show: false } : {}),
    ...(categoryFormat.title
      ? { name: categoryFormat.title, nameLocation: "middle" as const, nameGap: horizontal ? 52 : 32, nameTextStyle: base.axisName }
      : {}),
    axisLabel: {
      ...base.categoryAxis.axisLabel,
      ...(categoryFormat.size ? { fontSize: categoryFormat.size } : {}),
      ...(categoryFormat.color ? { color: categoryFormat.color } : {}),
      ...(categoryFormat.rotate !== undefined ? { rotate: categoryFormat.rotate } : {}),
      ...(categoryFormat.interval !== undefined ? { interval: categoryFormat.interval } : {}),
      // Long names on bars are shortened (the tooltip and table have them in full).
      ...(horizontal ? { width: compact ? 88 : 140, overflow: "truncate" as const } : {}),
    },
    axisLine: base.categoryAxis.axisLine,
    axisTick: base.categoryAxis.axisTick,
    splitLine: { show: categoryFormat.gridlines ?? false, lineStyle: gridLine(base.categoryAxis.splitLine.lineStyle) },
  };
  const percentAxis = makeNumberFormatter({ style: "percent", decimals: 0 }, "number");
  const axisFormatter = (index: number, settings: AxisFormat | undefined) =>
    settings?.number
      ? (value: number | string) => makeNumberFormatter(settings.number, seriesKind(spec, index), { currency: spec.currency, axis: true })(value)
      : seriesFormatter(spec, index, true);
  const leftFormatter = shares ? (value: number | string) => percentAxis(value) : axisFormatter(firstOn("left"), format.valueAxis);
  const leftSettings: AxisFormat = shares ? { ...format.valueAxis, log: false, max: "1", min: undefined, step: undefined } : format.valueAxis ?? {};
  const lines = { lineStyle: gridLine(base.valueAxis.splitLine.lineStyle) };
  const leftAxis = numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: !horizontal, compact, ...lines });
  return {
    ...common,
    xAxis: horizontal ? numberAxis(leftFormatter, theme, "left", leftSettings, { vertical: false, compact, ...lines }) : categoryAxis,
    yAxis: horizontal
      ? { ...categoryAxis, data: categories, inverse: categoryFormat.reverse !== true }
      : hasRightAxis
        ? [leftAxis, numberAxis(axisFormatter(firstOn("right"), format.rightAxis), theme, "right", format.rightAxis, { gridlines: false, compact, ...lines })]
        : [leftAxis],
    ...(horizontal ? {} : { xAxis: { ...categoryAxis, ...(categoryFormat.reverse ? { inverse: true } : {}) } }),
    // Each entry is a bar or line series; TypeScript can't narrow the mixed list.
    series: series as EChartsOption["series"],
  };
}
