/**
 * Limits for the MCP endpoint (decision 343): a light per-key request limit
 * and a cap on how much text one tool answer can be.
 */

/** Requests per key per minute. An AI asking a question makes a handful. */
export const MCP_REQUESTS_PER_MINUTE = 120;
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

/**
 * JSON text for a tool answer, or null when it's over the cap (the caller
 * then answers with a message asking for a narrower question).
 */
export function boundedJson(value: unknown, max = MAX_TOOL_TEXT): string | null {
  const text = JSON.stringify(value);
  return text.length > max ? null : text;
}
