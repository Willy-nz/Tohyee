import type { ChartFormat } from "@/lib/analytics/chart-format";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import type { Measure, ResultColumn, Visual } from "@/lib/analytics/query";

const CHARTS: ReadonlySet<Visual> = new Set(["column", "bar", "line", "area", "combo", "pie", "donut"]);

/**
 * A tile's chart, from its answer's value columns and its saved format. The
 * dashboard and pinned tiles both use this, so a chart looks the same in both.
 */
export function tileChartSpec(
  tile: { visual: Visual; format?: ChartFormat },
  measures: ResultColumn[],
  options: { compact?: boolean } = {},
): ChartSpec | null {
  if (!CHARTS.has(tile.visual) || measures.length === 0) return null;
  return {
    kind: tile.visual as ChartSpec["kind"],
    category: "category",
    series: measures.map((column, index) => ({
      field: column.key,
      label: column.label,
      kind: column.format === "money" ? ("money" as const) : ("number" as const),
      // Columns and line: the first value as columns and the rest as lines, unless chosen otherwise.
      ...(tile.visual === "combo" ? { as: index === 0 ? ("bar" as const) : ("line" as const) } : {}),
    })),
    valueFormat: measures[0]?.format === "money" ? "money" : "number",
    currency: "NZD",
    ...(options.compact ? { compact: true } : {}),
    ...(tile.format ? { format: tile.format } : {}),
  };
}

/**
 * The values a tile shows, in the order its answer has them (a value with
 * "and last year" or a previous period is followed by that figure). A chart's
 * per-value settings are saved in this order.
 */
export function tileValueNames(measures: Measure[]): string[] {
  return measures.flatMap((measure) =>
    measure.compare === "previous_year"
      ? [measure.label, `${measure.label} last year`]
      : measure.compare === "previous_period"
        ? [measure.label, `${measure.label} previous period`]
        : [measure.label],
  );
}
