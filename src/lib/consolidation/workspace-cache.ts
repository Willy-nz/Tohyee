/**
 * The group workspace's short-lived copies (decision 645; Codex, delegated
 * by owner, 20 October 2026). Each copy is one person's view: the key holds
 * who they are, their role in every member, the group's version and its
 * members' dates, so a changed role or membership never reuses an old copy.
 * Every change to a group (members, dates, steward, customer links, stage
 * mappings) also drops the group's copies outright. Copies are only ever
 * rebuilt from the members' own databases; nothing here is the record.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 200;

type Entry = { groupId: string; value: unknown; storedAt: number };

const entries = new Map<string, Entry>();

export function workspaceCacheKey(parts: {
  userId: string;
  groupId: string;
  version: number;
  periods: Array<{ organisationId: string; effectiveFrom: string | null; effectiveTo: string | null }>;
  roles: Array<[string, string | undefined]>;
  extra: string;
}): string {
  return JSON.stringify([
    parts.userId,
    parts.groupId,
    parts.version,
    parts.periods.map((period) => [period.organisationId, period.effectiveFrom, period.effectiveTo]),
    [...parts.roles].sort(([a], [b]) => a.localeCompare(b)),
    parts.extra,
  ]);
}

export function readWorkspaceCache<T>(key: string, now = Date.now()): { value: T; storedAt: number } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (now - entry.storedAt > TTL_MS) {
    entries.delete(key);
    return null;
  }
  return { value: entry.value as T, storedAt: entry.storedAt };
}

export function writeWorkspaceCache(key: string, groupId: string, value: unknown, now = Date.now()): void {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { groupId, value, storedAt: now });
}

/** Drops every copy of a group's workspace, for everyone. */
export function invalidateGroupWorkspace(groupId: string): void {
  for (const [key, entry] of entries) if (entry.groupId === groupId) entries.delete(key);
}

/** How many copies are held for a group (tests). */
export function workspaceCacheSize(groupId?: string): number {
  if (groupId === undefined) return entries.size;
  return [...entries.values()].filter((entry) => entry.groupId === groupId).length;
}
