import { ValidationError } from "@/lib/errors";

/**
 * How a dashboard chart looks (issues #331 and #333, decisions 590-593):
 * colours, labels, legend, axes, number formats and the card around it.
 * Saved on the tile (in the dashboard's `tiles` JSON) and checked here, so
 * only known settings with sensible values are ever stored. Every setting is
 * optional; leaving it out keeps the chart as it was before formatting
 * existed, so "Reset to default" just removes the settings.
 */

/** The chart colours by name, in their checked order (--chart-1 to --chart-8). */
export const HUES = ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"] as const;
export type Hue = (typeof HUES)[number];
export const HUE_LABELS: Record<Hue, string> = {
  blue: "Blue",
  orange: "Orange",
  aqua: "Aqua",
  yellow: "Yellow",
  magenta: "Pink",
  green: "Green",
  violet: "Purple",
  red: "Red",
};

/**
 * Colour sets. Each order was checked with a colour-vision validator in
 * light and dark (decision 591); "blues" is four steps of one blue, so it
 * only fits charts with up to four values (or groups, when coloured by group).
 */
export const PALETTES = {
  tohyee: { label: "Tohyee (blue first)", order: ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"] as Hue[] },
  blues: { label: "Tohyee blues (up to 4)", order: null },
  warm: { label: "Orange first", order: ["orange", "blue", "aqua", "yellow", "magenta", "green", "violet", "red"] as Hue[] },
  green: { label: "Green first", order: ["green", "blue", "orange", "aqua", "yellow", "magenta", "violet", "red"] as Hue[] },
} as const;
export type PaletteId = keyof typeof PALETTES;
export const BLUES_COUNT = 4;

export type NumberStyle = "auto" | "currency" | "percent" | "plain";
export type NumberFormat = {
  /** auto: money columns as dollars, everything else as a plain number. */
  style?: NumberStyle;
  /** Decimal places (0-4); left out, money shows 2 and other numbers up to 2. */
  decimals?: number;
  /** $1.5K rather than $1,500.00. */
  compact?: boolean;
  /** Thousands separator; on unless turned off. */
  thousands?: boolean;
  prefix?: string;
  suffix?: string;
};

export type SeriesFormat = {
  /** Columns and line: drawn as a column or a line. */
  as?: "bar" | "line";
  /** Columns and line, line and area: which axis it's measured on. */
  axis?: "left" | "right";
  color?: Hue;
  number?: NumberFormat;
};

export type AxisFormat = {
  title?: string;
  gridlines?: boolean;
  /** Display bounds, as typed numbers (e.g. "0", "1500"). */
  min?: string;
  max?: string;
  /** On unless turned off: the axis starts at zero. */
  zero?: boolean;
  log?: boolean;
};

export type LegendPosition = "top" | "bottom" | "right";
export type LabelPosition = "auto" | "inside" | "outside";

export type KpiCompare = "none" | "previous_period" | "previous_year" | "target";

/** Key figure settings (#334). */
export type KpiFormat = {
  compare?: KpiCompare;
  /** The target, a decimal string (exact). */
  target?: string;
  /** Show it as an amount, a percentage, or both. */
  change?: "both" | "amount" | "percent";
  /** For costs: a fall shows green. */
  downIsGood?: boolean;
  sparkline?: boolean;
};

export type ChartFormat = {
  palette?: PaletteId;
  /** By value, in the tile's value order. */
  series?: SeriesFormat[];
  colorByCategory?: boolean;
  negativeRed?: boolean;
  labels?: { show?: boolean; position?: LabelPosition };
  legend?: { show?: "auto" | "show" | "hide"; position?: LegendPosition };
  categoryAxis?: { title?: string; gridlines?: boolean };
  valueAxis?: AxisFormat;
  rightAxis?: AxisFormat;
  stack?: "none" | "stacked" | "percent";
  smooth?: boolean;
  markers?: boolean;
  donutTotal?: boolean;
  card?: { showTitle?: boolean; subtitle?: string; background?: "plain" | "tinted" | "none"; border?: boolean };
  kpi?: KpiFormat;
};

const NUMBER_TEXT = /^-?\d{1,15}(\.\d{1,6})?$/;

function text(value: unknown, max: number, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError(`${what} should be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${what} can be up to ${max} characters.`);
  return trimmed || undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!allowed.includes(value as T)) throw new ValidationError(`${what}: choose one of the options.`);
  return value as T;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string" || !NUMBER_TEXT.test(raw.trim())) throw new ValidationError(`${what} should be a number, e.g. 1500 or -2.5.`);
  return raw.trim();
}

/** Drops settings that are left out, so a saved format only holds what was changed. */
function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseNumberFormat(input: unknown, what: string): NumberFormat | undefined {
  const raw = object(input);
  let decimals: number | undefined;
  if (raw.decimals !== undefined && raw.decimals !== null && raw.decimals !== "") {
    decimals = Number(raw.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw new ValidationError(`${what}: decimal places are 0 to 4.`);
  }
  return compact({
    style: oneOf(raw.style, ["auto", "currency", "percent", "plain"] as const, what),
    decimals,
    compact: flag(raw.compact),
    thousands: flag(raw.thousands),
    prefix: text(raw.prefix, 20, `${what} prefix`),
    suffix: text(raw.suffix, 20, `${what} suffix`),
  });
}

function parseAxis(input: unknown, what: string): AxisFormat | undefined {
  const raw = object(input);
  const min = numberText(raw.min, `${what} minimum`);
  const max = numberText(raw.max, `${what} maximum`);
  if (min !== undefined && max !== undefined && Number(min) >= Number(max)) throw new ValidationError(`${what}: the maximum should be more than the minimum.`);
  return compact({
    title: text(raw.title, 60, `${what} title`),
    gridlines: flag(raw.gridlines),
    min,
    max,
    zero: flag(raw.zero),
    log: flag(raw.log),
  });
}

export function parseKpiFormat(input: unknown): KpiFormat | undefined {
  const raw = object(input);
  const compare = oneOf(raw.compare, ["none", "previous_period", "previous_year", "target"] as const, "Compare to");
  const target = numberText(raw.target, "Target");
  if (compare === "target" && target === undefined) throw new ValidationError("Enter the target to compare to.");
  return compact({
    compare,
    target,
    change: oneOf(raw.change, ["both", "amount", "percent"] as const, "Show the change as"),
    downIsGood: flag(raw.downIsGood),
    sparkline: flag(raw.sparkline),
  });
}

/** Checks a tile's saved format. Unknown settings are dropped; wrong values are refused. */
export function parseChartFormat(input: unknown): ChartFormat | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The chart's format isn't set up properly.");
  const raw = input as Record<string, unknown>;
  if (raw.series !== undefined && !Array.isArray(raw.series)) throw new ValidationError("The chart's value formats should be a list.");
  const seriesList = (Array.isArray(raw.series) ? raw.series : []).slice(0, 12).map((entry, index) => {
    const series = object(entry);
    const what = `Value ${index + 1}`;
    return (
      compact({
        as: oneOf(series.as, ["bar", "line"] as const, what),
        axis: oneOf(series.axis, ["left", "right"] as const, what),
        color: oneOf(series.color, HUES, `${what} colour`),
        number: parseNumberFormat(series.number, what),
      }) ?? {}
    );
  });
  while (seriesList.length && Object.keys(seriesList[seriesList.length - 1]).length === 0) seriesList.pop();
  const labels = object(raw.labels);
  const legend = object(raw.legend);
  const categoryAxis = object(raw.categoryAxis);
  const card = object(raw.card);
  return compact({
    palette: oneOf(raw.palette, Object.keys(PALETTES) as PaletteId[], "Colours"),
    series: seriesList.length ? seriesList : undefined,
    colorByCategory: flag(raw.colorByCategory),
    negativeRed: flag(raw.negativeRed),
    labels: compact({ show: flag(labels.show), position: oneOf(labels.position, ["auto", "inside", "outside"] as const, "Data labels") }),
    legend: compact({
      show: oneOf(legend.show, ["auto", "show", "hide"] as const, "Legend"),
      position: oneOf(legend.position, ["top", "bottom", "right"] as const, "Legend position"),
    }),
    categoryAxis: compact({ title: text(categoryAxis.title, 60, "Group axis title"), gridlines: flag(categoryAxis.gridlines) }),
    valueAxis: parseAxis(raw.valueAxis, "Value axis"),
    rightAxis: parseAxis(raw.rightAxis, "Right axis"),
    stack: oneOf(raw.stack, ["none", "stacked", "percent"] as const, "Stacking"),
    smooth: flag(raw.smooth),
    markers: flag(raw.markers),
    donutTotal: flag(raw.donutTotal),
    card: compact({
      showTitle: flag(card.showTitle),
      subtitle: text(card.subtitle, 200, "Subtitle"),
      background: oneOf(card.background, ["plain", "tinted", "none"] as const, "Background"),
      border: flag(card.border),
    }),
    kpi: parseKpiFormat(raw.kpi),
  });
}

/** What kind of number a value column holds (from its query column). */
export type ValueKind = "money" | "number";

/**
 * Formats a value for display. Values arrive as exact decimal strings and
 * are turned into numbers only here, to be drawn or shown (never added up).
 */
export function makeNumberFormatter(
  format: NumberFormat | undefined,
  kind: ValueKind,
  options: { currency?: string; axis?: boolean } = {},
): (value: number | string | null) => string {
  const style = format?.style && format.style !== "auto" ? format.style : kind === "money" ? "currency" : "plain";
  // Axes are compact unless the person turned it off for this value.
  const compactNotation = format?.compact ?? Boolean(options.axis);
  const decimals = format?.decimals;
  const grouping = format?.thousands !== false;
  const intl: Intl.NumberFormatOptions = { useGrouping: grouping };
  if (style === "currency") Object.assign(intl, { style: "currency", currency: options.currency ?? "NZD" });
  if (style === "percent") intl.style = "percent";
  if (compactNotation) {
    intl.notation = "compact";
    intl.minimumFractionDigits = 0;
    intl.maximumFractionDigits = decimals ?? 1;
  } else if (decimals !== undefined) {
    intl.minimumFractionDigits = decimals;
    intl.maximumFractionDigits = decimals;
  } else if (style === "currency") {
    intl.minimumFractionDigits = 2;
    intl.maximumFractionDigits = 2;
  } else {
    intl.maximumFractionDigits = 2;
  }
  const formatter = new Intl.NumberFormat("en-NZ", intl);
  const prefix = format?.prefix ? `${format.prefix}` : "";
  const suffix = format?.suffix ? ` ${format.suffix}` : "";
  return (value) => {
    if (value === null || value === "") return "";
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return "";
    return `${prefix}${formatter.format(number)}${suffix}`;
  };
}

/** A tile's settings that apply to a chart of this kind (for hiding options that don't). */
export function formatOptionsFor(visual: string) {
  const cartesian = ["column", "bar", "line", "area", "combo"].includes(visual);
  const round = visual === "pie" || visual === "donut";
  return {
    cartesian,
    round,
    secondAxis: visual === "combo" || visual === "line" || visual === "area",
    columnOrLine: visual === "combo",
    stack: visual === "column" || visual === "bar" || visual === "area" || visual === "combo",
    lines: visual === "line" || visual === "area" || visual === "combo",
    bars: visual === "column" || visual === "bar" || visual === "combo",
    donutTotal: visual === "donut",
    colorByCategory: visual === "column" || visual === "bar",
    kpi: visual === "kpi",
  };
}
