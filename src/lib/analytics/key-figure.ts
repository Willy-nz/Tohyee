import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { QueryResult, ResultColumn } from "@/lib/analytics/query";
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
