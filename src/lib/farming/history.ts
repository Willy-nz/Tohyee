import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";

/*
 * Bounded history pages for farm records (#447, decision 901). Every list of
 * readings, grazings and supplements is read a page at a time, newest first,
 * on the server, with optional From and To dates and a paddock. A page ends
 * with a cursor (the last row's date and id) for the next one, so rows added
 * while someone pages don't shift or repeat what they've seen. Summaries
 * (the farm's cover, the feed wedge, supplements by month) never use these
 * pages: they're worked out on their own, so paging can't change a total.
 */

export const HISTORY_PAGE_SIZE = 25;
export const MAX_HISTORY_PAGE_SIZE = 1000;

export type HistoryCursor = { date: string; id: string };

export type HistoryQuery = {
  from: string | null;
  to: string | null;
  limit: number;
  after: HistoryCursor | null;
};

export type HistoryPage<T> = { rows: T[]; next: string | null };

export type HistoryInput = { from?: unknown; to?: unknown; limit?: unknown; cursor?: unknown };

const blank = (value: unknown) => value === undefined || value === null || value === "";

export function encodeCursor(cursor: HistoryCursor): string {
  return `${cursor.date}_${cursor.id}`;
}

export function decodeCursor(input: unknown): HistoryCursor | null {
  if (blank(input)) return null;
  const match = typeof input === "string" ? /^(\d{4}-\d{2}-\d{2})_([1-9]\d{0,17})$/.exec(input) : null;
  if (!match) throw new ValidationError("That page link isn't valid. Start again from the newest records.");
  return { date: parseIsoDate(match[1], "Cursor date"), id: match[2] };
}

/** Reads the paging and date filters, with a page size from 1 to `max`. */
export function parseHistoryQuery(input: HistoryInput, options: { defaultLimit?: number; max?: number } = {}): HistoryQuery {
  const max = options.max ?? MAX_HISTORY_PAGE_SIZE;
  let limit = options.defaultLimit ?? HISTORY_PAGE_SIZE;
  if (!blank(input.limit)) {
    const value = typeof input.limit === "number" ? input.limit : Number(String(input.limit));
    if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationError(`Show from 1 to ${max.toLocaleString("en-NZ")} records at a time.`);
    limit = value;
  }
  const from = blank(input.from) ? null : parseIsoDate(input.from, "From");
  const to = blank(input.to) ? null : parseIsoDate(input.to, "To");
  if (from && to && to < from) throw new ValidationError("The To date can't be before the From date.");
  return { from, to, limit, after: decodeCursor(input.cursor) };
}

/**
 * SQL conditions for a query on `dateColumn` and `idColumn`, numbered from
 * `$start`. Returns the conditions (joined with "and") and their values.
 */
export function historyConditions(query: HistoryQuery, dateColumn: string, idColumn: string, start: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  /** Adds a value and returns its placeholder. */
  const value = (input: unknown) => {
    params.push(input);
    return `$${start + params.length - 1}`;
  };
  if (query.from) parts.push(`${dateColumn} >= ${value(query.from)}::date`);
  if (query.to) parts.push(`${dateColumn} <= ${value(query.to)}::date`);
  if (query.after) {
    const date = value(query.after.date);
    parts.push(`(${dateColumn}, ${idColumn}) < (${date}::date, ${value(query.after.id)}::bigint)`);
  }
  return { sql: parts.length ? parts.join(" and ") : "true", params };
}

/** Given up to `limit + 1` rows, newest first, the page and the cursor for the next. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => HistoryCursor): HistoryPage<T> {
  if (rows.length <= limit) return { rows, next: null };
  const page = rows.slice(0, limit);
  return { rows: page, next: encodeCursor(key(page[page.length - 1])) };
}
