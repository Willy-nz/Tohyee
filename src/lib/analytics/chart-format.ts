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

export type LineStyle = "solid" | "dashed" | "dotted";

export type SeriesFormat = {
  /** Columns and line: drawn as a column or a line. */
  as?: "bar" | "line";
  /** Columns and line, line and area: which axis it's measured on. */
  axis?: "left" | "right";
  color?: Hue;
  /** Any colour (#376), over the named one; left out, the theme's. */
  hex?: string;
  number?: NumberFormat;
  /** Lines: width in pixels (1-6), style, a step line, and dots (over the chart's own setting). */
  lineWidth?: number;
  lineStyle?: LineStyle;
  step?: boolean;
  markers?: boolean;
  /** In the tooltip (the default), left out of it, or only in it (not drawn). */
  tooltip?: "show" | "hide" | "only";
  /** A straight trend line (least squares) for this value. */
  trend?: boolean;
  /** Carries the trend on for this many groups (1-12): a simple forecast. */
  forecast?: number;
};

/** Text styling for a title, subtitle or label. */
export type TextStyle = {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
};

export type ReferenceKind = "constant" | "target" | "average" | "median" | "min" | "max" | "percentile" | "band";
export const REFERENCE_KINDS: ReferenceKind[] = ["constant", "target", "average", "median", "min", "max", "percentile", "band"];

/** A line (or shaded band) across the value axis (#376). */
export type ReferenceLine = {
  kind: ReferenceKind;
  /** Which value it's worked out from (by position; the first when left out). */
  series?: number;
  /** A constant or target, or a band's start (a decimal string). */
  value?: string;
  /** A band's end. */
  to?: string;
  /** 1-99, for a percentile. */
  percentile?: number;
  label?: string;
  color?: string;
  style?: LineStyle;
};

/** How an axis's labels look (#376), for both kinds of axis. */
export type AxisLook = {
  /** Off hides the axis entirely (labels and line). */
  show?: boolean;
  size?: number;
  color?: string;
  /** Label rotation in degrees (-90 to 90). */
  rotate?: number;
  reverse?: boolean;
};

export type AxisFormat = AxisLook & {
  title?: string;
  gridlines?: boolean;
  /** Display bounds, as typed numbers (e.g. "0", "1500"). */
  min?: string;
  max?: string;
  /** On unless turned off: the axis starts at zero. */
  zero?: boolean;
  log?: boolean;
  /** The axis's own number format, apart from the values' (#376). */
  number?: NumberFormat;
  /** The gap between steps, a number (e.g. "500"). */
  step?: string;
};

export type CategoryAxisFormat = AxisLook & {
  title?: string;
  gridlines?: boolean;
  /** Show every nth label: 0 shows all, 1 every second, and so on (0-50). */
  interval?: number;
  /** For dates: only groups from and to these dates. */
  from?: string;
  to?: string;
};

export type LegendPosition = "top" | "bottom" | "right" | "left" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const LEGEND_POSITIONS: LegendPosition[] = ["top", "bottom", "right", "left", "top-left", "top-right", "bottom-left", "bottom-right"];
export type LabelPosition = "auto" | "inside" | "outside";

/**
 * Key figure settings (#334). Comparing with the previous period or last
 * year is part of the question (the first value's `compare`), since it needs
 * its own figures; a target is just a number to compare with.
 */
export type KpiFormat = {
  /** The target, a decimal string (exact). */
  target?: string;
  /** Show the change as an amount, a percentage, or both. */
  change?: "both" | "amount" | "percent";
  /** For costs: a fall shows green. */
  downIsGood?: boolean;
};

export type CardFormat = {
  showTitle?: boolean;
  subtitle?: string;
  background?: "plain" | "tinted" | "none";
  border?: boolean;
  /** The title's look (#376), with an optional band of colour behind it. */
  title?: TextStyle & { background?: string };
  subtitleStyle?: TextStyle;
  /** Any background colour, with how solid it is (0-100%). */
  fill?: string;
  opacity?: number;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  shadow?: "none" | "soft" | "strong";
  padding?: number;
};

export type LabelDensity = "all" | "auto" | "ends";

export type ChartFormat = {
  palette?: PaletteId;
  /** By value, in the tile's value order. */
  series?: SeriesFormat[];
  colorByCategory?: boolean;
  /** Any colour for chosen groups, by the group's name as shown (#376). */
  categoryColors?: Array<{ name: string; color: string }>;
  negativeRed?: boolean;
  labels?: {
    show?: boolean;
    position?: LabelPosition;
    size?: number;
    color?: string;
    /** The labels' own number format, apart from the axis and tooltip. */
    number?: NumberFormat;
    /** Pie and donut: what each label says. */
    content?: { category?: boolean; value?: boolean; percent?: boolean };
    /** Every label, only those with room, or only the first and last. */
    density?: LabelDensity;
  };
  legend?: { show?: "auto" | "show" | "hide"; position?: LegendPosition; size?: number; title?: string };
  categoryAxis?: CategoryAxisFormat;
  valueAxis?: AxisFormat;
  rightAxis?: AxisFormat;
  gridlines?: { style?: LineStyle; color?: string };
  plot?: { background?: string };
  tooltip?: { show?: boolean; total?: boolean };
  referenceLines?: ReferenceLine[];
  bars?: { thickness?: number; gap?: number; rounded?: boolean };
  stack?: "none" | "stacked" | "percent";
  smooth?: boolean;
  markers?: boolean;
  donutTotal?: boolean;
  card?: CardFormat;
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

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/** Any colour, as #rrggbb (stored lower case). */
export function hexColour(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !HEX_COLOUR.test(value)) throw new ValidationError(`${what} should be a colour like #1f5fae.`);
  return value.toLowerCase();
}

function whole(value: unknown, low: number, high: number, what: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < low || number > high) throw new ValidationError(`${what} should be a whole number from ${low} to ${high}.`);
  return number;
}

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

function dateText(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = typeof value === "string" && DATE_TEXT.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  const ok = date !== null && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  if (!ok) throw new ValidationError(`${what} is a date, YYYY-MM-DD.`);
  return value as string;
}

function parseTextStyle(input: unknown, what: string, maxSize = 32): TextStyle | undefined {
  const raw = object(input);
  return compact({
    size: whole(raw.size, 8, maxSize, `${what} size`),
    bold: flag(raw.bold),
    italic: flag(raw.italic),
    color: hexColour(raw.color, `${what} colour`),
    align: oneOf(raw.align, ["left", "center", "right"] as const, `${what} alignment`),
  });
}

function parseAxisLook(raw: Record<string, unknown>, what: string): AxisLook {
  return {
    show: flag(raw.show),
    size: whole(raw.size, 8, 20, `${what} text size`),
    color: hexColour(raw.color, `${what} text colour`),
    rotate: whole(raw.rotate, -90, 90, `${what} label rotation`),
    reverse: flag(raw.reverse),
  };
}

function parseAxis(input: unknown, what: string): AxisFormat | undefined {
  const raw = object(input);
  const min = numberText(raw.min, `${what} minimum`);
  const max = numberText(raw.max, `${what} maximum`);
  if (min !== undefined && max !== undefined && Number(min) >= Number(max)) throw new ValidationError(`${what}: the maximum should be more than the minimum.`);
  const step = numberText(raw.step, `${what} step`);
  if (step !== undefined && Number(step) <= 0) throw new ValidationError(`${what}: the step should be more than zero.`);
  return compact({
    title: text(raw.title, 60, `${what} title`),
    gridlines: flag(raw.gridlines),
    min,
    max,
    zero: flag(raw.zero),
    log: flag(raw.log),
    ...parseAxisLook(raw, what),
    number: parseNumberFormat(raw.number, `${what} numbers`),
    step,
  });
}

function parseCategoryAxis(input: unknown): CategoryAxisFormat | undefined {
  const raw = object(input);
  const what = "Group axis";
  const from = dateText(raw.from, `${what} from`);
  const to = dateText(raw.to, `${what} to`);
  if (from && to && from > to) throw new ValidationError(`${what}: the to date should be on or after the from date.`);
  return compact({
    title: text(raw.title, 60, `${what} title`),
    gridlines: flag(raw.gridlines),
    ...parseAxisLook(raw, what),
    interval: whole(raw.interval, 0, 50, `${what} label interval`),
    from,
    to,
  });
}

const MAX_REFERENCE_LINES = 8;

function parseReferenceLines(input: unknown): ReferenceLine[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("Reference lines should be a list.");
  if (input.length > MAX_REFERENCE_LINES) throw new ValidationError(`A chart can have up to ${MAX_REFERENCE_LINES} reference lines.`);
  const lines = input.map((entry, index): ReferenceLine => {
    const raw = object(entry);
    const what = `Reference line ${index + 1}`;
    const kind = oneOf(raw.kind, REFERENCE_KINDS, what);
    if (!kind) throw new ValidationError(`${what}: choose what kind of line it is.`);
    const value = numberText(raw.value, `${what} value`);
    const to = numberText(raw.to, `${what} end`);
    if ((kind === "constant" || kind === "target" || kind === "band") && value === undefined) throw new ValidationError(`${what}: give it a value.`);
    if (kind === "band") {
      if (to === undefined) throw new ValidationError(`${what}: give the band an end.`);
      if (Number(to) <= Number(value)) throw new ValidationError(`${what}: the band's end should be more than its start.`);
    }
    const percentile = whole(raw.percentile, 1, 99, `${what} percentile`);
    if (kind === "percentile" && percentile === undefined) throw new ValidationError(`${what}: the percentile should be a whole number from 1 to 99.`);
    return compact({
      kind,
      series: whole(raw.series, 0, 11, `${what} value number`),
      value: kind === "constant" || kind === "target" || kind === "band" ? value : undefined,
      to: kind === "band" ? to : undefined,
      percentile: kind === "percentile" ? percentile : undefined,
      label: text(raw.label, 60, `${what} label`),
      color: hexColour(raw.color, `${what} colour`),
      style: oneOf(raw.style, ["solid", "dashed", "dotted"] as const, `${what} style`),
    }) as ReferenceLine;
  });
  return lines.length ? lines : undefined;
}

function parseCategoryColours(input: unknown): ChartFormat["categoryColors"] {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("Group colours should be a list.");
  if (input.length > 50) throw new ValidationError("A chart can colour up to 50 groups.");
  const seen = new Set<string>();
  const list = input.flatMap((entry, index) => {
    const raw = object(entry);
    const name = typeof raw.name === "string" ? raw.name.slice(0, 120) : "";
    const color = hexColour(raw.color, `Group colour ${index + 1}`);
    if (!name || !color || seen.has(name)) return [];
    seen.add(name);
    return [{ name, color }];
  });
  return list.length ? list : undefined;
}

function parseCard(input: unknown): CardFormat | undefined {
  const card = object(input);
  const title = object(card.title);
  return compact({
    showTitle: flag(card.showTitle),
    subtitle: text(card.subtitle, 200, "Subtitle"),
    background: oneOf(card.background, ["plain", "tinted", "none"] as const, "Background"),
    border: flag(card.border),
    title: compact({ ...parseTextStyle(card.title, "Title"), background: hexColour(title.background, "Title background") }),
    subtitleStyle: parseTextStyle(card.subtitleStyle, "Subtitle", 24),
    fill: hexColour(card.fill, "Card background"),
    opacity: whole(card.opacity, 0, 100, "Background opacity (0 to 100)"),
    borderColor: hexColour(card.borderColor, "Border colour"),
    borderWidth: whole(card.borderWidth, 0, 6, "Border width"),
    radius: whole(card.radius, 0, 24, "Corner radius"),
    shadow: oneOf(card.shadow, ["none", "soft", "strong"] as const, "Shadow"),
    padding: whole(card.padding, 0, 32, "Padding"),
  });
}

export function parseKpiFormat(input: unknown): KpiFormat | undefined {
  const raw = object(input);
  return compact({
    target: numberText(raw.target, "Target"),
    change: oneOf(raw.change, ["both", "amount", "percent"] as const, "Show the change as"),
    downIsGood: flag(raw.downIsGood),
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
        hex: hexColour(series.hex, `${what} colour`),
        number: parseNumberFormat(series.number, what),
        lineWidth: whole(series.lineWidth, 1, 6, `${what} line width`),
        lineStyle: oneOf(series.lineStyle, ["solid", "dashed", "dotted"] as const, `${what} line style`),
        step: flag(series.step),
        markers: flag(series.markers),
        tooltip: oneOf(series.tooltip, ["show", "hide", "only"] as const, `${what} tooltip`),
        trend: flag(series.trend),
        forecast: whole(series.forecast, 1, 12, `${what} forecast periods`),
      }) ?? {}
    );
  });
  while (seriesList.length && Object.keys(seriesList[seriesList.length - 1]).length === 0) seriesList.pop();
  const labels = object(raw.labels);
  const content = object(labels.content);
  const legend = object(raw.legend);
  const gridlines = object(raw.gridlines);
  const plot = object(raw.plot);
  const tooltip = object(raw.tooltip);
  const bars = object(raw.bars);
  return compact({
    palette: oneOf(raw.palette, Object.keys(PALETTES) as PaletteId[], "Colours"),
    series: seriesList.length ? seriesList : undefined,
    colorByCategory: flag(raw.colorByCategory),
    categoryColors: parseCategoryColours(raw.categoryColors),
    negativeRed: flag(raw.negativeRed),
    labels: compact({
      show: flag(labels.show),
      position: oneOf(labels.position, ["auto", "inside", "outside"] as const, "Data labels"),
      size: whole(labels.size, 8, 24, "Data label size"),
      color: hexColour(labels.color, "Data label colour"),
      number: parseNumberFormat(labels.number, "Data labels"),
      content: compact({ category: flag(content.category), value: flag(content.value), percent: flag(content.percent) }),
      density: oneOf(labels.density, ["all", "auto", "ends"] as const, "Label density"),
    }),
    legend: compact({
      show: oneOf(legend.show, ["auto", "show", "hide"] as const, "Legend"),
      position: oneOf(legend.position, LEGEND_POSITIONS, "Legend position"),
      size: whole(legend.size, 8, 20, "Legend text size"),
      title: text(legend.title, 60, "Legend title"),
    }),
    categoryAxis: parseCategoryAxis(raw.categoryAxis),
    valueAxis: parseAxis(raw.valueAxis, "Value axis"),
    rightAxis: parseAxis(raw.rightAxis, "Right axis"),
    gridlines: compact({ style: oneOf(gridlines.style, ["solid", "dashed", "dotted"] as const, "Gridline style"), color: hexColour(gridlines.color, "Gridline colour") }),
    plot: compact({ background: hexColour(plot.background, "Plot area background") }),
    tooltip: compact({ show: flag(tooltip.show), total: flag(tooltip.total) }),
    referenceLines: parseReferenceLines(raw.referenceLines),
    bars: compact({
      thickness: whole(bars.thickness, 4, 80, "Column thickness"),
      gap: whole(bars.gap, 0, 90, "Gap between groups"),
      rounded: flag(bars.rounded),
    }),
    stack: oneOf(raw.stack, ["none", "stacked", "percent"] as const, "Stacking"),
    smooth: flag(raw.smooth),
    markers: flag(raw.markers),
    donutTotal: flag(raw.donutTotal),
    card: parseCard(raw.card),
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
    // On an axis, at least one decimal, so close steps (3.5K and 4K) don't both read "4K".
    intl.maximumFractionDigits = options.axis ? Math.max(decimals ?? 1, 1) : decimals ?? 1;
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

/** The chart types a report can keep a default format for (#376, Power BI's visual defaults). */
export const DEFAULTABLE_VISUALS = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "table", "pivot"] as const;
export type DefaultableVisual = (typeof DEFAULTABLE_VISUALS)[number];
export type VisualDefaults = Partial<Record<DefaultableVisual, ChartFormat>>;

export const VISUAL_NAMES: Record<DefaultableVisual, string> = {
  column: "Columns",
  bar: "Bars",
  line: "Line",
  area: "Area",
  combo: "Columns and line",
  pie: "Pie",
  donut: "Donut",
  kpi: "Key figure",
  table: "Table",
  pivot: "Pivot table",
};

/**
 * A format to copy to other tiles (the format painter) or keep as a chart
 * type's default: everything but a key figure's target, which is a number
 * about the data rather than how it looks.
 */
export function painterFormat(format: ChartFormat | undefined): ChartFormat | undefined {
  if (!format) return undefined;
  const copy: ChartFormat = { ...format };
  if (copy.kpi) {
    const kpi = { ...copy.kpi };
    delete kpi.target;
    if (Object.keys(kpi).length) copy.kpi = kpi;
    else delete copy.kpi;
  }
  return Object.keys(copy).length ? copy : undefined;
}

/** A report's defaults by chart type, each checked like a tile's format (unknown types and settings dropped, wrong values refused). */
export function parseVisualDefaults(input: unknown): VisualDefaults | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The chart type defaults aren't set up properly.");
  const raw = input as Record<string, unknown>;
  const result: VisualDefaults = {};
  for (const visual of DEFAULTABLE_VISUALS) {
    if (raw[visual] === undefined) continue;
    let format: ChartFormat | undefined;
    try {
      format = painterFormat(parseChartFormat(raw[visual]));
    } catch (error) {
      throw new ValidationError(`Default for ${VISUAL_NAMES[visual]}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (format) result[visual] = format;
  }
  return Object.keys(result).length ? result : undefined;
}

function mergeObjects(base: unknown, own: unknown): unknown {
  if (own === undefined) return base;
  if (Array.isArray(base) && Array.isArray(own)) {
    return Array.from({ length: Math.max(base.length, own.length) }, (_unused, index) => mergeObjects(base[index], own[index]) ?? {});
  }
  if (base && own && typeof base === "object" && typeof own === "object" && !Array.isArray(base) && !Array.isArray(own)) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(own as Record<string, unknown>)) result[key] = mergeObjects(result[key], value);
    return result;
  }
  return own;
}

/** A tile's format over its report's default for its chart type: the tile's own settings win, one by one. */
export function mergeFormats(base: ChartFormat | undefined, own: ChartFormat | undefined): ChartFormat | undefined {
  if (!base) return own;
  if (!own) return base;
  return mergeObjects(base, own) as ChartFormat;
}

/** The format painter's paste: the copied format, keeping the target tile's own key figure target. */
export function pasteFormat(copied: ChartFormat | undefined, target: ChartFormat | undefined): ChartFormat | undefined {
  const format = painterFormat(copied);
  const keep = target?.kpi?.target;
  if (keep === undefined) return format;
  return { ...format, kpi: { ...format?.kpi, target: keep } };
}
