import { mergeFormats, type ChartFormat, type DefaultableVisual, type VisualDefaults } from "@/lib/analytics/chart-format";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import type { Measure, ResultColumn, TileQuery, Visual } from "@/lib/analytics/query";

const CHARTS: ReadonlySet<Visual> = new Set(["column", "bar", "line", "area", "combo", "pie", "donut", "waterfall", "funnel", "gauge", "bullet", "scatter", "histogram", "boxplot", "treemap", "heatmap", "calendar", "sankey", "filledmap", "pointmap"]);

/**
 * A tile's chart, from its answer's value columns and its saved format. The
 * dashboard and pinned tiles both use this, so a chart looks the same in both.
 */
export function tileChartSpec(
  tile: { visual: string; format?: ChartFormat; query?: { breakdown?: unknown } | null },
  measures: ResultColumn[],
  options: {
    compact?: boolean;
    /** The tile's question and whether its answer was cut short, so a linear projection knows its groups (decision 692). */
    query?: Pick<TileQuery, "groupBy" | "sort" | "limit"> | null;
    truncated?: boolean;
  } = {},
): ChartSpec | null {
  if (!CHARTS.has(tile.visual as Visual) || measures.length === 0) return null;
  const query = options.query;
  return {
    kind: tile.visual as ChartSpec["kind"],
    category: "category",
    ...(tile.query?.breakdown ? { detail: "breakdown" } : {}),
    series: measures.map((column, index) => ({
      field: column.key,
      label: column.label,
      kind: column.format === "money" ? ("money" as const) : ("number" as const),
      ...(column.format === "percent" ? { percent: true } : {}),
      ...(column.number ? { number: column.number } : {}),
      // Columns and line: the first value as columns and the rest as lines, unless chosen otherwise.
      ...(tile.visual === "combo" ? { as: index === 0 ? ("bar" as const) : ("line" as const) } : {}),
    })),
    valueFormat: measures[0]?.format === "money" ? "money" : "number",
    currency: "NZD",
    ...(options.compact ? { compact: true } : {}),
    ...(tile.format ? { format: tile.format } : {}),
    ...(query
      ? { projection: { grain: query.groupBy?.grain ?? null, sort: query.sort, limit: query.limit ?? null, truncated: options.truncated ?? false } }
      : {}),
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

/**
 * A tile as it's drawn: its own format over its report's default for its
 * chart type (#376), so the dashboard, the editor's preview and pinned tiles
 * all agree. A tile with no default to use comes back unchanged.
 */
export function tileWithDefaults<T extends { visual: string; format?: ChartFormat }>(tile: T, defaults: VisualDefaults | undefined): T {
  const base = defaults?.[tile.visual as DefaultableVisual];
  if (!base) return tile;
  const format = mergeFormats(base, tile.format);
  return format ? { ...tile, format } : tile;
}
