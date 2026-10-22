import { ValidationError } from "@/lib/errors";
import { DATE_PRESETS, isDatePreset, presetRange, type DatePreset } from "@/lib/analytics/date-ranges";
import type { ColumnInfo, Filter } from "@/lib/analytics/query";

/**
 * A tile's own dates and a page's own filters (#376 phase 3, decision
 * 758; Looker Studio's per-chart date range, Power BI's page-level
 * filters). Both are saved with the report, so a reader can't change them.
 */

/** A tile's own dates, in place of the report's: dates that move with today, or fixed ones. */
export type TileDates = { preset: DatePreset } | { from: string | null; to: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTileDates(input: unknown, what: string): TileDates | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (raw.preset !== undefined) {
    if (!isDatePreset(raw.preset)) throw new ValidationError(`${what}: choose its dates from the list.`);
    return { preset: raw.preset };
  }
  const date = (value: unknown, label: string) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !DATE.test(value)) throw new ValidationError(`${what}: ${label} is YYYY-MM-DD.`);
    return value;
  };
  const from = date(raw.from, "its From date");
  const to = date(raw.to, "its To date");
  if (from && to && from > to) throw new ValidationError(`${what}: its From date is after its To date.`);
  return { from, to };
}

/** The dates a tile shows: its own, if it has them, otherwise the report's (with the reader's choice). */
export function effectiveDates(own: TileDates | undefined, report: { from?: string | null; to?: string | null }, today: string, yearEndMonth: number): { from: string | null; to: string | null } {
  if (!own) return { from: report.from ?? null, to: report.to ?? null };
  if ("preset" in own) return presetRange(own.preset, today, yearEndMonth);
  return { from: own.from, to: own.to };
}

/** Said on the tile, so it's clear it doesn't follow the report's dates. */
export function tileDatesText(own: TileDates | undefined, format: (date: string) => string = (date) => date): string | null {
  if (!own) return null;
  if ("preset" in own) return `Dates: ${DATE_PRESETS.find((preset) => preset.value === own.preset)?.label.toLowerCase() ?? own.preset}`;
  if (own.from && own.to) return `Dates: ${format(own.from)} to ${format(own.to)}`;
  if (own.from) return `Dates: from ${format(own.from)}`;
  if (own.to) return `Dates: up to ${format(own.to)}`;
  return "Dates: all time";
}

/** A page's filter: a test on a table's column, applied to the page's tiles whose table has the column. */
export type PageFilter = { table: string; filter: Filter };
export const MAX_PAGE_FILTERS = 6;

export function parsePageFilters(
  input: unknown,
  tables: Map<string, ColumnInfo[]>,
  parseFilter: (entry: unknown, columns: Map<string, string>, what: string, joins: boolean) => Filter,
  page: string,
): PageFilter[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw new ValidationError(`${page}: the page's filters aren't set up properly.`);
  if (input.length > MAX_PAGE_FILTERS) throw new ValidationError(`${page}: a page can have up to ${MAX_PAGE_FILTERS} filters.`);
  const filters = input.map((entry, index) => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const table = typeof raw.table === "string" ? raw.table : "";
    const columns = tables.get(table);
    if (!columns) throw new ValidationError(`${page}, filter ${index + 1}: choose a data source.`);
    const filter = parseFilter(raw.filter, new Map(columns.map((column) => [column.name, column.type])), `${page}, filter ${index + 1}`, false);
    return { table, filter };
  });
  return filters.length ? filters : undefined;
}
