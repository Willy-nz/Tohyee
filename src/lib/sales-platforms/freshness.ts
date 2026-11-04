/**
 * How up to date a store's data in Tohyee is (#572). Pure functions, shared
 * with the browser: the store card and the AI's status say the same thing.
 * `lastSyncAt` is the last attempt; only `lastSuccessfulSyncAt` says what
 * the books are up to date with.
 */

/** The catch-up sync runs every 15 minutes; an active store not synced for an hour is behind. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Whether the store refused Tohyee's login, so only new credentials fix it:
 * a 401 or 403 from the store ("x.myshopify.com said 401: ..."), or the
 * token request turning the app's client ID and secret down.
 */
export function needsReconnect(status: string, lastError: string | null): boolean {
  if (status === "disconnected" || !lastError) return false;
  return /\bsaid 40[13]\b/.test(lastError) || /\binvalid_client\b|\bshop_not_permitted\b/i.test(lastError);
}

export type FreshnessInput = {
  status: string;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  failures: number;
};

export type Freshness = {
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  minutesSinceLastSuccessfulSync: number | null;
  /** True while paused, failing, never synced, or not synced successfully for an hour: the data may be out of date. */
  behind: boolean;
  /** Why it's behind, as a code: paused, failing, never_synced, stale. Null when it isn't. */
  behindReason: "paused" | "failing" | "never_synced" | "stale" | null;
  needsReconnect: boolean;
  /** What a person should do, in plain words, or null when nothing. */
  action: string | null;
};

/** The freshness of a connection that isn't disconnected (a disconnected one is never "behind": it isn't meant to sync). */
export function syncFreshness(connection: FreshnessInput, now: Date, platformLabel: string): Freshness {
  const success = connection.lastSuccessfulSyncAt ? Date.parse(connection.lastSuccessfulSyncAt) : null;
  const reconnect = needsReconnect(connection.status, connection.lastError);
  const disconnected = connection.status === "disconnected";
  const behindReason: Freshness["behindReason"] = disconnected
    ? null
    : connection.status === "paused"
      ? "paused"
      : connection.failures > 0
        ? "failing"
        : success === null
          ? "never_synced"
          : now.getTime() - success > STALE_AFTER_MS
            ? "stale"
            : null;
  const action = reconnect
    ? `${platformLabel} no longer accepts Tohyee's login. Reconnect the store with new credentials (Settings › Sales platforms › Reconnect); nothing is brought in until then.`
    : behindReason === "paused"
      ? `Syncing is paused after failures in a row. Fix what the last error says, then choose "Sync now".`
      : behindReason === "failing"
        ? "The last sync failed; the next one tries again in 15 minutes."
        : null;
  return {
    lastSyncAt: connection.lastSyncAt,
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
    minutesSinceLastSuccessfulSync: success === null ? null : Math.max(0, Math.floor((now.getTime() - success) / 60000)),
    behind: behindReason !== null,
    behindReason,
    needsReconnect: reconnect,
    action,
  };
}
