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
  /** The number's look (#376): a size or a size in pixels, colour, alignment, weight. */
  size?: "s" | "m" | "l" | "xl";
  sizePx?: number;
  color?: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  /** The value's name above or below the number (left out: none; the card's title names it). */
  label?: "none" | "above" | "below";
  /** Colour the number by rules on its value, or green or red by the comparison. */
  colorBy?: "none" | "rules" | "change";
  rules?: KpiRule[];
  /** An arrow (direction) or a dot (the number's colour) by the number. */
  icon?: "none" | "arrow" | "dot";
  /** How the trend underneath is drawn, and its colour. */
  sparkline?: "line" | "area" | "column";
  sparkColor?: string;
  /** Every value as its own number, side by side (Power BI's multi-row card). */
  multi?: boolean;
};

/** "If the value is >= 1000, show it green": compared exactly, the first that matches wins. */
export type KpiRule = { op: ">=" | ">" | "<=" | "<" | "="; value: string; color: string };

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
  /** Zoom along the group axis with a slider (decision 760; time charts). */
  zoom?: boolean;
  donutTotal?: boolean;
  card?: CardFormat;
  kpi?: KpiFormat;
  /** Table and pivot cells coloured by a scale, rules or a field (#376). */
  conditional?: ConditionalFormat[];
  /** A bar in the cell behind each value. */
  dataBars?: Array<{ value: number; color?: string }>;
  /** An icon by each value: high, middle or low third of the column. */
  icons?: Array<{ value: number; set: IconSet }>;
  /** Columns, bars and dots coloured by rules, e.g. red below a target. */
  chartRules?: Array<KpiRule & { series?: number }>;
  /** How a table or pivot looks. */
  table?: TableStyle;
  /** Waterfall: the total bar and the colours for rises, falls and the total (#376 phase 2). */
  waterfall?: WaterfallFormat;
  /** Funnel: the percentage each stage shows. */
  funnel?: FunnelFormat;
  /** Gauge: its range and a target. */
  gauge?: GaugeFormat;
  /** Bullet chart: a target and the shaded bands behind each bar. */
  bullet?: BulletFormat;
  /** Scatter and bubble: the across (x) axis, as the value axis is the up (y) one. */
  xAxis?: AxisFormat;
  scatter?: { trend?: boolean };
  /** Histogram: how many bins, or how wide each is (a decimal string); left out, worked out from the values. */
  histogram?: { bins?: number; width?: string };
  /** Box plot: dots for values beyond the whiskers; on unless turned off. */
  boxplot?: { outliers?: boolean };
  /** Small multiples: the most small charts (2-12, left out 6); the rest become "Other". */
  smallMultiples?: { max?: number };
  /** Filled map: regions or territorial authorities; left out, whichever more of the group names match (decision 687). */
  map?: { areas?: "regions" | "districts" };
};

export type WaterfallFormat = {
  /** A bar for the total at the end; on unless turned off. */
  total?: boolean;
  totalLabel?: string;
  /** Thin lines joining each bar to the next; on unless turned off. */
  connectors?: boolean;
  increase?: string;
  decrease?: string;
  totalColor?: string;
};

export type FunnelFormat = {
  /** Each stage as a share of the first stage (the default), of the stage before, or no share. */
  percent?: "first" | "previous" | "none";
};

export type GaugeFormat = {
  /** The ends of the dial (decimal strings); left out, 0 and twice the value (or the target, if bigger). */
  min?: string;
  max?: string;
  /** A target when the tile has no second value. */
  target?: string;
};

export type BulletFormat = {
  /** A target when the tile has no second value. */
  target?: string;
  /** Where the shaded bands change, as percentages of the target (ascending, up to 3); left out, 60 and 80. */
  bands?: number[];
};

export type IconSet = "arrows" | "shapes";

/** Colour a value's cells (by its position among the tile's values). */
export type ConditionalFormat = {
  value: number;
  apply: "background" | "font";
  by: "scale" | "rules" | "field";
  /** A two- or three-colour scale from the column's lowest to highest. */
  low?: string;
  mid?: string;
  high?: string;
  rules?: KpiRule[];
  /** A field holding colours: the group column, or a value by position. */
  field?: "category" | number;
};

export type TableStyle = {
  headerBackground?: string;
  headerColor?: string;
  banded?: boolean;
  bandColor?: string;
  gridlines?: "all" | "rows" | "none";
  fontSize?: number;
  /** The narrowest a column gets, in pixels. */
  columnWidth?: number;
  wrap?: boolean;
  /** A totals row (tables) or the grand total (pivots; on unless turned off). */
  totals?: boolean;
  totalsStyle?: "bold" | "shaded";
  /** Pivot subtotal levels to leave out (1 is the first row field). */
  subtotalsOff?: number[];
  /** Pivot rows in a column per field (tabular, the default) or stepped: one indented column with each group's total as its heading (#376 phase 2). */
  layout?: "tabular" | "stepped";
  /** Pivot row groups shown open to start with, by level (1: only the first row field's groups are listed); left out, all open. */
  expandTo?: number;
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

function parseKpiRules(input: unknown): KpiRule[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("Colour rules should be a list.");
  if (input.length > 6) throw new ValidationError("A key figure can have up to 6 colour rules.");
  const rules = input.map((entry, index): KpiRule => {
    const raw = object(entry);
    const what = `Colour rule ${index + 1}`;
    const op = oneOf(raw.op, [">=", ">", "<=", "<", "="] as const, what);
    const value = numberText(raw.value, `${what} value`);
    const color = hexColour(raw.color, `${what} colour`);
    if (!op || value === undefined) throw new ValidationError(`${what}: choose a comparison and a number.`);
    if (!color) throw new ValidationError(`${what}: choose a colour.`);
    return { op, value, color };
  });
  return rules.length ? rules : undefined;
}

function parseConditional(input: unknown): ConditionalFormat[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("Conditional formats should be a list.");
  if (input.length > 10) throw new ValidationError("A table can have up to 10 conditional formats.");
  const list = input.map((entry, index): ConditionalFormat => {
    const raw = object(entry);
    const what = `Conditional format ${index + 1}`;
    const value = whole(raw.value, 0, 11, `${what} value`);
    const apply = oneOf(raw.apply, ["background", "font"] as const, what);
    const by = oneOf(raw.by, ["scale", "rules", "field"] as const, what);
    if (value === undefined || !apply || !by) throw new ValidationError(`${what}: choose the value, what to colour and how.`);
    if (by === "scale") {
      const low = hexColour(raw.low, `${what} lowest colour`);
      const high = hexColour(raw.high, `${what} highest colour`);
      if (!low || !high) throw new ValidationError(`${what}: a colour scale needs at least two colours.`);
      return compact({ value, apply, by, low, mid: hexColour(raw.mid, `${what} middle colour`), high }) as ConditionalFormat;
    }
    if (by === "rules") {
      const rules = parseKpiRules(raw.rules);
      if (!rules) throw new ValidationError(`${what}: add at least one rule.`);
      return { value, apply, by, rules };
    }
    const field = raw.field === "category" ? "category" : whole(raw.field, 0, 11, `${what} field`);
    if (field === undefined) throw new ValidationError(`${what}: choose the field that holds the colours.`);
    return { value, apply, by, field };
  });
  return list.length ? list : undefined;
}

function parseTableStyle(input: unknown): TableStyle | undefined {
  const raw = object(input);
  let subtotalsOff: number[] | undefined;
  if (raw.subtotalsOff !== undefined && raw.subtotalsOff !== null) {
    if (!Array.isArray(raw.subtotalsOff)) throw new ValidationError("Subtotals should be a list of levels.");
    subtotalsOff = [...new Set(raw.subtotalsOff.map((level) => {
      const number = whole(level, 1, 4, "Subtotal level");
      if (number === undefined) throw new ValidationError("Subtotal level should be a whole number from 1 to 4.");
      return number;
    }))].sort();
    if (!subtotalsOff.length) subtotalsOff = undefined;
  }
  return compact({
    headerBackground: hexColour(raw.headerBackground, "Header background"),
    headerColor: hexColour(raw.headerColor, "Header text colour"),
    banded: flag(raw.banded),
    bandColor: hexColour(raw.bandColor, "Band colour"),
    gridlines: oneOf(raw.gridlines, ["all", "rows", "none"] as const, "Table gridlines"),
    fontSize: whole(raw.fontSize, 10, 18, "Table text size"),
    columnWidth: whole(raw.columnWidth, 60, 400, "Column width"),
    wrap: flag(raw.wrap),
    totals: flag(raw.totals),
    totalsStyle: oneOf(raw.totalsStyle, ["bold", "shaded"] as const, "Totals style"),
    subtotalsOff,
    layout: oneOf(raw.layout, ["tabular", "stepped"] as const, "Pivot layout"),
    expandTo: whole(raw.expandTo, 1, 4, "Levels shown open"),
  });
}

function parseValueList<T extends { value: number }>(input: unknown, what: string, item: (raw: Record<string, unknown>, label: string) => Omit<T, "value">): T[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError(`${what} should be a list.`);
  if (input.length > 12) throw new ValidationError(`${what}: up to 12.`);
  const list = input.map((entry, index) => {
    const raw = object(entry);
    const label = `${what} ${index + 1}`;
    const value = whole(raw.value, 0, 11, `${label} value`);
    if (value === undefined) throw new ValidationError(`${label}: choose the value.`);
    return { value, ...item(raw, label) } as T;
  });
  return list.length ? list : undefined;
}

function parseChartRules(input: unknown): Array<KpiRule & { series?: number }> | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError("Chart colour rules should be a list.");
  const rules = parseKpiRules(input);
  return rules?.map((rule, index) => compact({ ...rule, series: whole(object(input[index]).series, 0, 11, `Colour rule ${index + 1} value`) }) as KpiRule & { series?: number });
}

export function parseKpiFormat(input: unknown): KpiFormat | undefined {
  const raw = object(input);
  return compact({
    target: numberText(raw.target, "Target"),
    change: oneOf(raw.change, ["both", "amount", "percent"] as const, "Show the change as"),
    downIsGood: flag(raw.downIsGood),
    size: oneOf(raw.size, ["s", "m", "l", "xl"] as const, "Number size"),
    sizePx: whole(raw.sizePx, 16, 96, "Number size in pixels (16 to 96)"),
    color: hexColour(raw.color, "Number colour"),
    align: oneOf(raw.align, ["left", "center", "right"] as const, "Number alignment"),
    bold: flag(raw.bold),
    label: oneOf(raw.label, ["none", "above", "below"] as const, "Value name"),
    colorBy: oneOf(raw.colorBy, ["none", "rules", "change"] as const, "Colour the number by"),
    rules: parseKpiRules(raw.rules),
    icon: oneOf(raw.icon, ["none", "arrow", "dot"] as const, "Icon"),
    sparkline: oneOf(raw.sparkline, ["line", "area", "column"] as const, "Trend style"),
    sparkColor: hexColour(raw.sparkColor, "Trend colour"),
    multi: flag(raw.multi),
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
    zoom: flag(raw.zoom),
    markers: flag(raw.markers),
    donutTotal: flag(raw.donutTotal),
    card: parseCard(raw.card),
    kpi: parseKpiFormat(raw.kpi),
    conditional: parseConditional(raw.conditional),
    dataBars: parseValueList<{ value: number; color?: string }>(raw.dataBars, "Data bar", (entry, label) => compact({ color: hexColour(entry.color, `${label} colour`) }) ?? {}),
    icons: parseValueList<{ value: number; set: IconSet }>(raw.icons, "Icon set", (entry, label) => {
      const set = oneOf(entry.set, ["arrows", "shapes"] as const, label);
      if (!set) throw new ValidationError(`${label}: choose the icons.`);
      return { set };
    }),
    chartRules: parseChartRules(raw.chartRules),
    table: parseTableStyle(raw.table),
    waterfall: parseWaterfall(raw.waterfall),
    funnel: compact({ percent: oneOf(object(raw.funnel).percent, ["first", "previous", "none"] as const, "Funnel percentage") }),
    gauge: parseGauge(raw.gauge),
    bullet: parseBullet(raw.bullet),
    xAxis: parseAxis(raw.xAxis, "Across axis"),
    scatter: compact({ trend: flag(object(raw.scatter).trend) }),
    histogram: parseHistogram(raw.histogram),
    boxplot: compact({ outliers: flag(object(raw.boxplot).outliers) }),
    smallMultiples: compact({ max: whole(object(raw.smallMultiples).max, 2, 12, "Most small charts") }),
    map: compact({ areas: oneOf(object(raw.map).areas, ["regions", "districts"] as const, "Map areas") }),
  });
}

function parseHistogram(input: unknown): ChartFormat["histogram"] {
  const raw = object(input);
  const width = numberText(raw.width, "Bin width");
  if (width !== undefined && Number(width) <= 0) throw new ValidationError("Bin width should be more than zero.");
  const bins = whole(raw.bins, 2, 50, "Number of bins");
  if (width !== undefined && bins !== undefined) throw new ValidationError("Choose a number of bins or a bin width, not both.");
  return compact({ bins, width });
}

function parseWaterfall(input: unknown): WaterfallFormat | undefined {
  const raw = object(input);
  return compact({
    total: flag(raw.total),
    totalLabel: text(raw.totalLabel, 40, "Total bar name"),
    connectors: flag(raw.connectors),
    increase: hexColour(raw.increase, "Rise colour"),
    decrease: hexColour(raw.decrease, "Fall colour"),
    totalColor: hexColour(raw.totalColor, "Total colour"),
  });
}

function parseGauge(input: unknown): GaugeFormat | undefined {
  const raw = object(input);
  const min = numberText(raw.min, "Gauge minimum");
  const max = numberText(raw.max, "Gauge maximum");
  if (min !== undefined && max !== undefined && Number(min) >= Number(max)) throw new ValidationError("Gauge: the maximum should be more than the minimum.");
  return compact({ min, max, target: numberText(raw.target, "Gauge target") });
}

function parseBullet(input: unknown): BulletFormat | undefined {
  const raw = object(input);
  let bands: number[] | undefined;
  if (raw.bands !== undefined && raw.bands !== null) {
    if (!Array.isArray(raw.bands) || raw.bands.length > 3) throw new ValidationError("Bullet bands: up to 3 percentages.");
    bands = raw.bands.map((entry, index) => {
      const value = whole(entry, 1, 300, `Bullet band ${index + 1} (% of the target)`);
      if (value === undefined) throw new ValidationError(`Bullet band ${index + 1}: enter a percentage of the target.`);
      return value;
    });
    if (bands.some((value, index) => index > 0 && value <= bands![index - 1])) throw new ValidationError("Bullet bands should go up, e.g. 60 then 80.");
  }
  return compact({ target: numberText(raw.target, "Bullet target"), bands });
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
    /** Has a value axis and a group axis to format (#376 phase 2 visuals included). */
    axes: ["column", "bar", "line", "area", "combo", "waterfall", "bullet", "scatter", "histogram", "boxplot"].includes(visual),
    /** Colour rules on the marks. */
    rules: ["column", "bar", "line", "area", "combo", "waterfall", "bullet", "funnel", "gauge", "scatter"].includes(visual),
    /** Shows a legend. */
    legend: !["kpi", "gauge", "funnel", "waterfall", "bullet", "scatter", "histogram", "boxplot", "treemap", "heatmap", "calendar", "sankey", "filledmap", "pointmap"].includes(visual),
    /** Column thickness and rounded ends. */
    thickness: ["column", "bar", "combo", "waterfall", "bullet", "histogram", "boxplot"].includes(visual),
    /** Data labels on the marks. */
    labels: !["kpi", "gauge", "boxplot", "calendar"].includes(visual),
    /** The group axis is numbers too (scatter's across axis), or its groups are bins (histogram). */
    groupAxis: !["scatter"].includes(visual),
    scatter: visual === "scatter",
    histogram: visual === "histogram",
    boxplot: visual === "boxplot",
    /** Coloured by amount on a scale (no per-value colour). */
    scale: visual === "heatmap" || visual === "calendar" || visual === "filledmap",
    filledmap: visual === "filledmap",
    pointmap: visual === "pointmap",
    treemap: visual === "treemap",
    sankey: visual === "sankey",
    waterfall: visual === "waterfall",
    funnel: visual === "funnel",
    gauge: visual === "gauge",
    bullet: visual === "bullet",
  };
}

/** Chart types that use a second grouping inside the first (#376 phase 2), and what it's called for each. */
export const SECOND_GROUPING: Partial<Record<string, { label: string; none: string | null; hint: string }>> = {
  column: { label: "One small chart for each", none: "Nothing (one chart)", hint: "Small multiples: e.g. a chart for each region, all on the same scale" },
  bar: { label: "One small chart for each", none: "Nothing (one chart)", hint: "Small multiples: e.g. a chart for each region, all on the same scale" },
  line: { label: "One small chart for each", none: "Nothing (one chart)", hint: "Small multiples: e.g. a chart for each region, all on the same scale" },
  boxplot: { label: "Each box is made of", none: "Nothing: one box of every group's value", hint: "e.g. boxes by region, each made of its customers' totals" },
  treemap: { label: "Inside each box", none: "Nothing", hint: "e.g. regions, each split into its products" },
  heatmap: { label: "Down the side", none: null, hint: "The groups go across; e.g. months across, products down" },
  sankey: { label: "Flows to", none: null, hint: "Each group flows to these, e.g. accounts to their contacts" },
};

/** Chart types whose second grouping must be chosen. */
export const SECOND_GROUPING_REQUIRED = ["heatmap", "sankey"];

/** The chart types a report can keep a default format for (#376, Power BI's visual defaults). */
export const DEFAULTABLE_VISUALS = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "table", "pivot", "waterfall", "funnel", "gauge", "bullet", "scatter", "histogram", "boxplot", "treemap", "heatmap", "calendar", "sankey", "filledmap", "pointmap"] as const;
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
  waterfall: "Waterfall",
  funnel: "Funnel",
  gauge: "Gauge",
  bullet: "Bullet chart",
  scatter: "Scatter or bubble",
  histogram: "Histogram",
  boxplot: "Box plot",
  treemap: "Treemap",
  heatmap: "Heat map",
  calendar: "Calendar heat map",
  sankey: "Sankey",
  filledmap: "Filled map",
  pointmap: "Map with points",
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
  // A gauge's range and target, and a bullet chart's target, are numbers about the data too.
  delete copy.gauge;
  if (copy.bullet) {
    const bullet = { ...copy.bullet };
    delete bullet.target;
    if (Object.keys(bullet).length) copy.bullet = bullet;
    else delete copy.bullet;
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
  const result: ChartFormat = { ...format };
  if (keep !== undefined) result.kpi = { ...format?.kpi, target: keep };
  if (target?.gauge) result.gauge = target.gauge;
  if (target?.bullet?.target !== undefined) result.bullet = { ...format?.bullet, target: target.bullet.target };
  return Object.keys(result).length ? result : undefined;
}
