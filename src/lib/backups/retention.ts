/**
 * Which backups to keep: the newest backup of each of the 14 most recent days
 * that have one, plus the first backup of each of the 12 most recent months
 * that have one. Everything else is deleted. Counting days that have a backup
 * (not calendar days) means a server that was off for a while still keeps 14.
 */
export const KEEP_DAILY = 14;
export const KEEP_MONTHLY = 12;

export type DatedBackup = { name: string; /** YYYY-MM-DD_HHmmss, local time */ stamp: string };

export function backupsToKeep<T extends DatedBackup>(backups: T[], daily = KEEP_DAILY, monthly = KEEP_MONTHLY): Set<string> {
  const sorted = [...backups].sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)); // newest first
  const keep = new Set<string>();

  const days = new Set<string>();
  for (const backup of sorted) {
    const day = backup.stamp.slice(0, 10);
    if (days.has(day)) continue;
    if (days.size >= daily) break;
    days.add(day);
    keep.add(backup.name);
  }

  const firstOfMonth = new Map<string, T>();
  for (const backup of sorted) firstOfMonth.set(backup.stamp.slice(0, 7), backup); // oldest wins, as we go newest to oldest
  const months = [...firstOfMonth.keys()].sort().reverse().slice(0, monthly);
  for (const month of months) keep.add(firstOfMonth.get(month)!.name);

  return keep;
}
