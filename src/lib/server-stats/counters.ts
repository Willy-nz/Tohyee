/**
 * Counts kept in memory for the server app's Stats page (decision 332): API
 * requests and how long they took, server errors, and who has used Tohyee
 * lately. Nothing here is stored; a restart starts again from zero. Only
 * counts leave this file, never who.
 */

type Counters = {
  requests: number;
  serverErrors: number;
  totalMs: number;
  slowestMs: number;
  /** User id -> when they last made a signed-in request (ms). */
  lastSeen: Map<string, number>;
};

const holder = globalThis as typeof globalThis & { __tohyeeStatsCounters?: Counters };

function counters(): Counters {
  holder.__tohyeeStatsCounters ??= { requests: 0, serverErrors: 0, totalMs: 0, slowestMs: 0, lastSeen: new Map() };
  return holder.__tohyeeStatsCounters;
}

/** One API request finished. */
export function countRequest(durationMs: number, status: number): void {
  const c = counters();
  c.requests += 1;
  if (status >= 500) c.serverErrors += 1;
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  c.totalMs += ms;
  if (ms > c.slowestMs) c.slowestMs = ms;
}

/** A signed-in person used Tohyee just now. */
export function noteActiveUser(userId: string, now = Date.now()): void {
  counters().lastSeen.set(userId, now);
}

export type RequestCounts = { requests: number; serverErrors: number; averageMs: number | null; slowestMs: number | null };

/** The requests since the last call, and starts counting again. */
export function takeRequestCounts(): RequestCounts {
  const c = counters();
  const taken: RequestCounts = {
    requests: c.requests,
    serverErrors: c.serverErrors,
    averageMs: c.requests > 0 ? Math.round(c.totalMs / c.requests) : null,
    slowestMs: c.requests > 0 ? Math.round(c.slowestMs) : null,
  };
  c.requests = 0;
  c.serverErrors = 0;
  c.totalMs = 0;
  c.slowestMs = 0;
  return taken;
}

/** How many people made a signed-in request in the last `withinMs` (and forgets anyone idle a day). */
export function activeUsers(withinMs: number, now = Date.now()): number {
  const seen = counters().lastSeen;
  let count = 0;
  for (const [id, at] of seen) {
    if (now - at > 24 * 60 * 60 * 1000) seen.delete(id);
    else if (now - at <= withinMs) count += 1;
  }
  return count;
}

/** For tests. */
export function resetCounters(): void {
  holder.__tohyeeStatsCounters = undefined;
}
