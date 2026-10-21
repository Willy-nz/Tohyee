import type { ChartFormat, KpiRule, TableStyle } from "@/lib/analytics/chart-format";
import type { PivotRow, ResultColumn } from "@/lib/analytics/query";
import { cmp, dec, sum, toFixedString } from "@/lib/money/decimal";
import { CHART_TOKENS } from "@/lib/charts/theme";

/**
 * Conditional formatting for tables and pivots (#376; Power BI's
 * background colour, font colour, data bars and icons). Rules compare values
 * exactly in decimals; colour scales, data bars and icon thirds only place
 * colours, so they use display numbers.
 */

/** Whether a rule matches a value, compared exactly. */
export function ruleMatches(rule: KpiRule, value: string): boolean {
  const order = cmp(dec(value), dec(rule.value));
  if (rule.op === ">=") return order >= 0;
  if (rule.op === ">") return order > 0;
  if (rule.op === "<=") return order <= 0;
  if (rule.op === "<") return order < 0;
  return order === 0;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function blend(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  return `#${x.map((value, index) => Math.round(value + (y[index] - value) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** A colour `t` of the way (0 to 1) along a two- or three-colour scale. */
export function scaleColour(scale: { low: string; mid?: string; high: string }, t: number): string {
  const share = Math.min(1, Math.max(0, t));
  if (!scale.mid) return blend(scale.low, scale.high, share);
  return share <= 0.5 ? blend(scale.low, scale.mid, share * 2) : blend(scale.mid, scale.high, (share - 0.5) * 2);
}

/** A column's lowest and highest values (blanks left out). */
export function columnRange(values: Array<string | null | undefined>): { low: number; high: number } | null {
  const numbers = values.flatMap((value) => {
    if (value === null || value === undefined) return [];
    const number = Number(value);
    return Number.isFinite(number) ? [number] : [];
  });
  if (!numbers.length) return null;
  return { low: Math.min(...numbers), high: Math.max(...numbers) };
}

/** Colour names a field may hold, in the chart theme's colours. */
const NAMED: Record<string, string> = {
  blue: CHART_TOKENS.light.series[0],
  orange: CHART_TOKENS.light.series[1],
  aqua: CHART_TOKENS.light.series[2],
  yellow: CHART_TOKENS.light.series[3],
  pink: CHART_TOKENS.light.series[4],
  green: CHART_TOKENS.light.series[5],
  purple: CHART_TOKENS.light.series[6],
  red: CHART_TOKENS.light.status.critical,
  grey: "#8b94a1",
  gray: "#8b94a1",
};

/** A field's value as a colour: a #rrggbb or one of a few names; anything else is no colour. */
export function fieldColour(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  return NAMED[text] ?? null;
}

/** White or near-black text, whichever reads on a fill. */
export function inkOn(fill: string): string {
  const [r, g, b] = channels(fill).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.0555 ? "#ffffff" : "#0b1018";
}

export type CellLook = {
  background?: string;
  color?: string;
  /** The text colour was picked to read on the fill, not chosen. */
  autoInk?: boolean;
  bar?: { percent: number; color: string | undefined };
  icon?: { glyph: string; label: "high" | "middle" | "low"; tone: "good" | "same" | "bad" };
};

/** Each state has its own shape as well as its colour, so colour is never the only sign. */
const ICONS = {
  arrows: { high: "▲", middle: "▶", low: "▼" },
  shapes: { high: "●", middle: "◆", low: "■" },
} as const;

/**
 * How one cell looks: the value's position among the tile's values, its
 * exact value, its column's range, and the row's field colour (the group
 * column's text, for "by a field").
 */
export function cellLook(format: ChartFormat | undefined, valueIndex: number, value: string | null, range: { low: number; high: number } | null, field: string | null): CellLook {
  if (!format || value === null) return {};
  const look: CellLook = {};
  const number = Number(value);
  const share = range && Number.isFinite(number) ? (range.high === range.low ? 1 : (number - range.low) / (range.high - range.low)) : null;
  let fontChosen = false;
  for (const rule of format.conditional ?? []) {
    if (rule.value !== valueIndex) continue;
    let colour: string | null = null;
    if (rule.by === "scale" && share !== null && rule.low && rule.high) colour = scaleColour({ low: rule.low, mid: rule.mid, high: rule.high }, share);
    if (rule.by === "rules") colour = rule.rules?.find((entry) => ruleMatches(entry, value))?.color ?? null;
    if (rule.by === "field") colour = fieldColour(field);
    if (!colour) continue;
    if (rule.apply === "background") look.background = colour;
    else {
      look.color = colour;
      fontChosen = true;
    }
  }
  // Text that reads on a coloured cell, unless a font colour was chosen.
  if (look.background && !fontChosen) {
    look.color = inkOn(look.background);
    look.autoInk = true;
  }
  const bar = format.dataBars?.find((entry) => entry.value === valueIndex);
  if (bar && share !== null) {
    // Bars grow from zero when the column has no negatives, so their lengths compare.
    const low = Math.min(range!.low, 0);
    const width = range!.high === low ? 100 : ((number - low) / (range!.high - low)) * 100;
    look.bar = { percent: Math.round(Math.max(0, Math.min(100, width)) * 10) / 10, color: bar.color };
  }
  const icons = format.icons?.find((entry) => entry.value === valueIndex);
  if (icons && share !== null && ICONS[icons.set]) {
    const label = share >= 2 / 3 ? "high" : share >= 1 / 3 ? "middle" : "low";
    look.icon = { glyph: ICONS[icons.set][label], label, tone: label === "high" ? "good" : label === "low" ? "bad" : "same" };
  }
  return look;
}

const ADDITIVE = new Set(["sum", "count"]);

/**
 * A table's totals row. With the server's totals (every row worked out
 * again as one total, decision 694), each value is that: a calculated value
 * or average from the totals (10/100 and 90/300 total 25%, not 20%), and
 * amounts in two currencies blank. Without them (Top N, or cut short):
 * totals and counts of the rows shown are added exactly; the others are
 * left blank, since adding them up would be wrong.
 */
export function tableTotals(
  columns: ResultColumn[],
  rows: Array<Record<string, string | null>>,
  aggregates: string[],
  serverTotals?: Record<string, string | null>,
): Record<string, string | null> {
  const measures = columns.filter((column) => column.role === "measure");
  const totals: Record<string, string | null> = {};
  for (const column of columns) {
    const index = measures.indexOf(column);
    if (index >= 0 && serverTotals) {
      totals[column.key] = serverTotals[column.key] ?? null;
      continue;
    }
    if (index < 0 || !ADDITIVE.has(aggregates[index] ?? "")) {
      totals[column.key] = null;
      continue;
    }
    const values = rows.map((row) => row[column.key]).filter((value): value is string => value !== null && value !== undefined);
    const decimals = values.map((value) => dec(value));
    // Kept to the places the values have (0.10 + 0.20 is 0.30).
    totals[column.key] = decimals.length ? toFixedString(sum(decimals), Math.max(...decimals.map((value) => value.scale))) : null;
  }
  return totals;
}

/** A pivot's rows without the subtotal levels turned off (and the grand total, when that's off). */
export function visiblePivotRows(rows: PivotRow[], style: TableStyle | undefined): PivotRow[] {
  const off = new Set(style?.subtotalsOff ?? []);
  return rows.filter((row) => {
    if (row.kind === "grand_total") return style?.totals !== false;
    if (row.kind === "subtotal") return !off.has(row.depth);
    return true;
  });
}
