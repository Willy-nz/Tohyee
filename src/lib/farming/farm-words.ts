/*
 * Short, plain wording for farm screens (#447, decision 903). Pure and
 * browser-safe: no judging words ("high", "low", "overdue"), only facts.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24 Oct", with the year when it isn't `today`'s year ("24 Oct 2025"). */
export function shortDate(iso: string, today: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const text = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
  return match[1] === today.slice(0, 4) ? text : `${text} ${match[1]}`;
}

/** Whole days from one ISO date to another (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "today", "yesterday", "5 days ago" — a fact about a date, for a reading's or grazing's age. */
export function daysAgo(iso: string, today: string): string {
  const days = daysBetween(iso, today);
  if (days < 0) return `in ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** "3,057 kg DM/ha": a cover with its unit beside the number. */
export function coverText(cover: number): string {
  return `${cover.toLocaleString("en-NZ")} kg DM/ha`;
}

/** "Milkers (300)": a mob and its head count when known. */
export function mobText(mob: string, head: number | null): string {
  return head ? `${mob} (${head.toLocaleString("en-NZ")})` : mob;
}
