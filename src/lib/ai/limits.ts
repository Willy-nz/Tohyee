import { ValidationError } from "@/lib/errors";
/**
 * Limits for the MCP endpoint (decision 343): a light per-key request limit
 * and a cap on how much text one tool answer can be.
 */

/** Requests per key per minute. An AI asking a question makes a handful. */
export const MCP_REQUESTS_PER_MINUTE = 120;
/** Wrong or revoked keys per address per minute before that address is told to wait. */
export const MCP_FAILED_KEYS_PER_MINUTE = 30;
/** A tool answer bigger than this (characters of JSON) is refused with a hint to narrow it. */
export const MAX_TOOL_TEXT = 200_000;

/**
 * A fixed-window counter per key, kept in memory (a restart starts again).
 * Returns false once a key has used its requests for the current minute.
 */
export class RequestLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  take(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (this.windows.size > 10_000) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  /** Whether a key has used its requests for the current window, without counting one. */
  spent(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    return Boolean(window && now - window.start < this.windowMs && window.count >= this.limit);
  }

  /** Whole seconds until the key's window starts again (at least 1), for a Retry-After header. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const window = this.windows.get(key);
    if (!window) return 1;
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}

/** A whole number from a tool argument, within [1, max], or the default. */
export function boundedLimit(input: unknown, fallback: number, max: number): number {
  if (input === undefined || input === null || input === "") return fallback;
  const value = typeof input === "number" ? input : typeof input === "string" && /^\d+$/.test(input.trim()) ? Number(input.trim()) : NaN;
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/** The first `max` items, and whether any were left out. */
export function firstRows<T>(rows: readonly T[], max: number): { rows: T[]; truncated: boolean; total: number } {
  return { rows: rows.slice(0, max), truncated: rows.length > max, total: rows.length };
}

/** A page of history (decision 901) in the same shape: `truncated` when there's more past the limit. */
export function historyRows<T>(page: { rows: T[]; next: string | null }): { rows: T[]; truncated: boolean; total: number | null } {
  return { rows: page.rows, truncated: page.next !== null, total: page.next === null ? page.rows.length : null };
}

/**
 * JSON text for a tool answer, or null when it's over the cap (the caller
 * then answers with a message asking for a narrower question).
 */
export function boundedJson(value: unknown, max = MAX_TOOL_TEXT): string | null {
  const text = JSON.stringify(value, isoTimestamps);
  return text.length > max ? null : text;
}

const POSTGRES_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A timestamp as ISO 8601 UTC (#579, decision 1381), e.g.
 * "2026-11-04T09:30:00.000Z", whether it came as a Date or as Postgres text
 * ("2026-11-04 22:30:00.123456+13"). Anything else comes back unchanged.
 */
export function isoUtc(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : value.toISOString();
  if (typeof value !== "string") return value;
  const match = POSTGRES_TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, time, fraction = "", zone] = match;
  const offset = zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}${fraction.slice(0, 4)}${offset}`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** JSON.stringify's replacer for tool answers: every `...At` field is ISO 8601 UTC (#579). `asAt` is a report's date, not a time. */
function isoTimestamps(this: unknown, key: string, value: unknown): unknown {
  if (!key.endsWith("At") || key === "asAt") return value;
  // JSON.stringify has already turned a Date into ISO text by now; read the original.
  const original = this && typeof this === "object" ? (this as Record<string, unknown>)[key] : value;
  return isoUtc(original);
}

/** The `cursor` input of a paged AI list (#538, #574, decision 1267): the `nextCursor` from the page before. */
export const CURSOR = { type: "string", description: "nextCursor from the last page, for the next one. Keep the same filters." } as const;

/** A list's `limit` input. */
export function limitInput(fallback: number, max: number) {
  return { type: "integer", minimum: 1, maximum: max, description: `Default ${fallback}, at most ${max}.` } as const;
}

/**
 * The cursor a list tool was given (#574, decision 1377): `cursor`, or an
 * older name for it (offset, beforeId) kept for now so older prompts work.
 */
export function cursorOf(args: Record<string, unknown>, ...aliases: string[]): unknown {
  if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") return args.cursor;
  for (const alias of aliases) {
    const value = args[alias];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** A position cursor: how many rows came before this page. */
export function positionOf(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const text = String(cursor).trim();
  if (!/^\d{1,9}$/.test(text)) throw new ValidationError("That cursor isn't valid. Start again without a cursor.");
  return Number(text);
}

/**
 * One page of a list by position (#574): for lists whose rows have no id of
 * their own, or a service that pages by offset. `nextCursor` is the number of
 * rows shown so far, null on the last page.
 */
export function pageByPosition<T>(rows: readonly T[], cursor: unknown, limit: number): { rows: T[]; more: boolean; nextCursor: string | null } {
  const start = positionOf(cursor);
  const page = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { rows: page, more, nextCursor: more ? String(start + page.length) : null };
}

/**
 * One page of a list a service returns whole (#538, decision 1267): up to
 * `limit` rows after the row whose id is `cursor`, in the list's own order.
 * `nextCursor` is null on the last page. A cursor that's no longer in the
 * list (the row went, or the filters changed) is refused rather than
 * silently starting again.
 */
export function pageAfter<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  cursor: unknown,
  limit: number,
): { rows: T[]; more: boolean; nextCursor: string | null } {
  let start = 0;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    const text = String(cursor);
    const index = rows.findIndex((row) => idOf(row) === text);
    if (index < 0) throw new ValidationError("That cursor isn't in this list any more (it changed, or the filters differ). Start again without a cursor.");
    start = index + 1;
  }
  const page = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return { rows: page, more, nextCursor: more && page.length > 0 ? idOf(page[page.length - 1]) : null };
}

/**
 * One page from a service that takes an offset and a limit (#574): asks for
 * one row more than the page to know whether there's more.
 */
export async function pageByOffset<T>(
  cursor: unknown,
  limit: number,
  fetch: (offset: number, count: number) => Promise<T[]>,
): Promise<{ rows: T[]; more: boolean; nextCursor: string | null }> {
  const start = positionOf(cursor);
  const rows = await fetch(start, limit + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { rows: page, more, nextCursor: more ? String(start + page.length) : null };
}
