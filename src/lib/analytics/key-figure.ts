import type { ChartFormat } from "@/lib/analytics/chart-format";
import { ruleMatches } from "@/lib/analytics/conditional";
import type { QueryResult, ResultColumn, TrendPoint } from "@/lib/analytics/query";
import { abs, cmp, dec, divide, isZero, mul, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/** What a key figure shows (#334, decision 595), worked out exactly from the answer's decimal strings. */
export type KeyFigure = {
  column: ResultColumn;
  value: string | null;
  /** What it's compared with, if anything. */
  comparison: { label: string; value: string | null } | null;
  /** value - comparison, exact. */
  change: string | null;
  /** The change as a percentage of the comparison (1 decimal place), or null when that's zero or missing. */
  percent: string | null;
  direction: "up" | "down" | "same" | null;
  /** Whether the change is good news: up, unless "down is good". */
  good: boolean | null;
  /** Any further values on the tile, shown underneath. */
  others: Array<{ column: ResultColumn; value: string | null }>;
};

const HUNDRED = dec("100");

export function keyFigure(result: QueryResult, format?: ChartFormat): KeyFigure | null {
  const measures = result.columns.filter((column) => column.role === "measure");
  const first = measures[0];
  if (!first) return null;
  const row = result.rows[0] ?? {};
  const value = row[first.key] ?? null;
  const compareColumn = measures.find((column) => column.key === `${first.key}_pp` || column.key === `${first.key}_py`);
  const target = format?.kpi?.target;
  const comparison = compareColumn
    ? { label: compareColumn.key.endsWith("_pp") ? "previous period" : "same period last year", value: row[compareColumn.key] ?? null }
    : target !== undefined
      ? { label: "target", value: target }
      : null;
  const others = measures.filter((column) => column !== first && column !== compareColumn).map((column) => ({ column, value: row[column.key] ?? null }));
  if (!comparison || comparison.value === null || value === null) {
    return { column: first, value, comparison, change: null, percent: null, direction: null, good: null, others };
  }
  const current = dec(value);
  const previous = dec(comparison.value);
  const change = sub(current, previous);
  const direction = cmp(change, ZERO_DECIMAL) > 0 ? "up" : cmp(change, ZERO_DECIMAL) < 0 ? "down" : "same";
  const percent = isZero(previous) ? null : toFixedString(divide(mul(change, HUNDRED), abs(previous), 1), 1);
  const downIsGood = format?.kpi?.downIsGood === true;
  const good = direction === "same" ? null : (direction === "up") !== downIsGood;
  return { column: first, value, comparison, change: toFixedString(change, Math.max(current.scale, previous.scale)), percent, direction, good, others };
}

/**
 * The number's colour (#376): the first matching rule's, "good" or "bad"
 * by the comparison, a fixed colour, or null for the theme's text colour.
 * "Good" and "bad" are drawn in the status colours with an arrow and words
 * beside them, so colour is never the only sign.
 */
export function figureColour(figure: KeyFigure, format: ChartFormat | undefined): string | "good" | "bad" | null {
  const kpi = format?.kpi;
  if (kpi?.colorBy === "rules") {
    if (figure.value === null) return null;
    return kpi.rules?.find((rule) => ruleMatches(rule, figure.value!))?.color ?? null;
  }
  if (kpi?.colorBy === "change") return figure.good === null ? null : figure.good ? "good" : "bad";
  return kpi?.color ?? null;
}

const SIZES = { s: 22, m: 30, l: 40, xl: 56 } as const;

/** The number's size, alignment and weight as inline styles (checked values only). */
export function figureStyle(format: ChartFormat | undefined): Record<string, string | number> {
  const kpi = format?.kpi;
  const style: Record<string, string | number> = {};
  const size = kpi?.sizePx ?? (kpi?.size ? SIZES[kpi.size] : undefined);
  // Never wider than the card: big numbers shrink with a narrow card (a container query unit).
  if (size) style.fontSize = `min(${size}px, 14cqi)`;
  if (kpi?.align) {
    style.textAlign = kpi.align;
    style.justifyItems = kpi.align === "center" ? "center" : kpi.align === "right" ? "end" : "start";
  }
  if (kpi?.bold !== undefined) style.fontWeight = kpi.bold ? 700 : 500;
  return style;
}

/** Every value on the tile as its own number (a value's comparison stays with the first). */
export function keyFigureNumbers(result: QueryResult): Array<{ column: ResultColumn; value: string | null }> {
  const row = result.rows[0] ?? {};
  return result.columns
    .filter((column) => column.role === "measure" && !/_(pp|py)$/.test(column.key))
    .map((column) => ({ column, value: row[column.key] ?? null }));
}

/** Where the trend's points sit in a width x height box (display numbers only; null where there's no value). */
export function sparkPoints(trend: TrendPoint[], width: number, height: number, inset = 6): Array<{ x: number; y: number | null; value: number | null }> {
  const values = trend.map((point) => (point.value === null ? null : Number(point.value)));
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (trend.length < 2 || numbers.length < 2) return [];
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const span = high - low || 1;
  return values.map((value, index) => ({
    x: inset + (index * (width - inset * 2)) / (trend.length - 1),
    y: value === null || !Number.isFinite(value) ? null : height - inset - ((value - low) * (height - inset * 2)) / span,
    value,
  }));
}
