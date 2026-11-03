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
  const text = JSON.stringify(value);
  return text.length > max ? null : text;
}

/** The `cursor` input of a paged AI list (#538, decision 1267): the `nextCursor` from the page before. */
export const CURSOR = { type: "string", description: "nextCursor from the last page, for the next one. Keep the same filters." } as const;

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
