import { HUES, PALETTES, type ChartFormat, type Hue } from "@/lib/analytics/chart-format";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import { chartGroupNames } from "@/lib/analytics/chart-spec";
import { niceCeiling } from "@/lib/analytics/chart-visuals";
import { adaptForDark } from "@/lib/charts/colour-check";
import { abs, add, cmp, dec, isDecimalString, sum, toPlainString, type Decimal } from "@/lib/money/decimal";

/**
 * Small multiples (#376 phase 2, decision 681; Power BI's small multiples):
 * one small chart for each value of the tile's second grouping, all with
 * the same groups along the axis and the same value scale, so they can be
 * compared at a glance. Past the cap, the smaller ones are added together
 * as "Other" (exactly), or left out when their values can't be added up.
 */

type Row = Record<string, string | number | null>;

export const DEFAULT_MULTIPLES = 6;
export const MAX_MULTIPLES = 12;

export type Facet = { name: string; rows: Row[]; other?: boolean };
export type SmallMultiples = {
  facets: Facet[];
  /** How many values of the second grouping were folded into Other, or left out. */
  folded: number;
  /** True when the rest were left out because their values can't be added (averages, smallest, largest, distinct counts, formulas). */
  omitted: boolean;
  /** The shared value scale (display numbers), unless the tile chose its own. */
  min?: number;
  max?: number;
};

function exact(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return isDecimalString(text) ? dec(text) : null;
}

/** A round number at or below a negative value, for the bottom of a shared scale. */
function niceFloor(value: number): number {
  return value >= 0 ? 0 : -niceCeiling(-value);
}

export function smallMultiples(
  rows: Row[],
  spec: Pick<ChartSpec, "kind" | "category" | "series" | "detail" | "stacked">,
  options: { max?: number; additive: boolean[]; format?: ChartFormat } = { additive: [] },
): SmallMultiples {
  const detail = spec.detail ?? "breakdown";
  const fields = spec.series.map((series) => series.field);
  // The groups along the axis, in the answer's order, the same in every small chart.
  const categories: Array<string | number | null> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(row[spec.category] ?? null);
    if (!seen.has(key)) {
      seen.add(key);
      categories.push(row[spec.category] ?? null);
    }
  }
  // Each value of the second grouping, in the answer's order, with its size (the first value's total, ignoring sign).
  const values = new Map<string, { raw: string | number | null; size: Decimal; rows: Map<string, Row> }>();
  for (const row of rows) {
    const key = JSON.stringify(row[detail] ?? null);
    const entry = values.get(key) ?? { raw: row[detail] ?? null, size: dec("0"), rows: new Map<string, Row>() };
    entry.size = add(entry.size, abs(exact(row[fields[0]]) ?? dec("0")));
    entry.rows.set(JSON.stringify(row[spec.category] ?? null), row);
    values.set(key, entry);
  }
  const cap = Math.min(MAX_MULTIPLES, Math.max(2, options.max ?? DEFAULT_MULTIPLES));
  const all = [...values.values()];
  const kept = all.length <= cap ? all : [...all].sort((a, b) => cmp(b.size, a.size)).slice(0, cap - 1);
  const keptSet = new Set(kept);
  const rest = all.filter((entry) => !keptSet.has(entry));
  const names = chartGroupNames(all.map((entry) => entry.raw));
  const nameOf = (entry: (typeof all)[number]) => names[all.indexOf(entry)] || "(blank)";
  const fill = (lookup: (categoryKey: string) => Row | undefined): Row[] =>
    categories.map((category) => {
      const found = lookup(JSON.stringify(category));
      return { [spec.category]: category, ...Object.fromEntries(fields.map((field) => [field, found?.[field] ?? null])) };
    });
  const facets: Facet[] = all.filter((entry) => keptSet.has(entry)).map((entry) => ({ name: nameOf(entry), rows: fill((key) => entry.rows.get(key)) }));
  const additive = fields.every((_field, index) => options.additive[index] === true);
  if (rest.length && additive) {
    facets.push({
      name: "Other",
      other: true,
      rows: categories.map((category) => {
        const key = JSON.stringify(category);
        return {
          [spec.category]: category,
          ...Object.fromEntries(
            fields.map((field) => {
              const parts = rest.map((entry) => exact(entry.rows.get(key)?.[field])).filter((value): value is Decimal => value !== null);
              return [field, parts.length ? toPlainString(sum(parts)) : null];
            }),
          ),
        };
      }),
    });
  }

  // One value scale for every small chart: from the lowest to the highest point drawn (stacks as their totals).
  const format = options.format ?? {};
  const stacked = (format.stack ?? (spec.stacked ? "stacked" : "none")) === "stacked" && spec.kind !== "line";
  if ((format.stack ?? "none") === "percent") return { facets, folded: rest.length, omitted: rest.length > 0 && !additive };
  let low = 0;
  let high = 0;
  for (const facet of facets) {
    for (const row of facet.rows) {
      const numbers = fields.map((field) => Number(row[field] ?? NaN)).filter((number) => Number.isFinite(number));
      if (stacked) {
        high = Math.max(high, numbers.filter((number) => number > 0).reduce((total, number) => total + number, 0));
        low = Math.min(low, numbers.filter((number) => number < 0).reduce((total, number) => total + number, 0));
      } else {
        for (const number of numbers) {
          high = Math.max(high, number);
          low = Math.min(low, number);
        }
      }
    }
  }
  return {
    facets,
    folded: rest.length,
    omitted: rest.length > 0 && !additive,
    ...(format.valueAxis?.log ? {} : { min: niceFloor(low) }),
    max: high > 0 ? niceCeiling(high) : 0,
  };
}

/** A small chart's spec: the tile's chart for one value of the second grouping, on the shared scale, with no legend of its own. */
export function facetSpec(spec: ChartSpec, multiples: SmallMultiples, index: number): ChartSpec {
  const { detail: _detail, ...rest } = spec;
  void _detail;
  const format: ChartFormat = { ...spec.format };
  const own = spec.format?.valueAxis ?? {};
  if (multiples.max !== undefined && own.max === undefined && multiples.max > 0) format.valueAxis = { ...format.valueAxis, max: String(multiples.max) };
  if (multiples.min !== undefined && own.min === undefined && multiples.min < 0) format.valueAxis = { ...format.valueAxis, min: String(multiples.min) };
  // One legend for them all sits above the small charts (so every plot is the same size).
  format.legend = { ...format.legend, show: "hide" };
  void index;
  return { ...rest, compact: true, format };
}

/** Which of a tile's values can be added together across small charts (totals and counts can; averages, smallest, largest, distinct counts and formulas can't). */
export function additiveValues(measures: Array<{ aggregate: string }>): boolean[] {
  return measures.map((measure) => measure.aggregate === "sum" || measure.aggregate === "count");
}

/**
 * A value's colour as CSS, for the one legend above small multiples: its
 * chosen colour, else its place in the tile's colour set (the theme's
 * `--chart-*` variables, so a report theme carries through).
 */
export function seriesSwatch(format: ChartFormat | undefined, index: number): string {
  const own = format?.series?.[index];
  // A chosen colour gets its worked-out dark version in dark mode (decision 672).
  if (own?.hex) return `light-dark(${own.hex}, ${adaptForDark(own.hex, "mark")})`;
  const hueVar = (hue: Hue) => `var(--chart-${HUES.indexOf(hue) + 1})`;
  if (own?.color) return hueVar(own.color);
  const palette = format?.palette ?? "tohyee";
  if (palette === "blues" && index < 4) return `var(--chart-blues-${index + 1})`;
  const order = palette === "tohyee" || palette === "blues" ? null : PALETTES[palette].order;
  if (order && index < order.length) return hueVar(order[index]);
  return `var(--chart-${index + 1})`;
}
