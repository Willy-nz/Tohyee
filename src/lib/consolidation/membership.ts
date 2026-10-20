/**
 * Group membership dates (decision 640, #200; Codex, delegated by owner,
 * 20 October 2026). Browser-safe, pure.
 *
 * A member is in the group from `effectiveFrom` to `effectiveTo`, both days
 * included; null means "from the start" or "still in it". An organisation
 * can leave and come back: each stay is its own period, and they never
 * overlap.
 */

export type MemberPeriod = { organisationId: string; effectiveFrom: string | null; effectiveTo: string | null };

/** Whether the period covers `date`. */
export function coversDate(period: MemberPeriod, date: string): boolean {
  return (period.effectiveFrom === null || period.effectiveFrom <= date) && (period.effectiveTo === null || period.effectiveTo >= date);
}

/** Whether the period hasn't ended by `today` (it's current, or starts later). */
export function notEnded(period: MemberPeriod, today: string): boolean {
  return period.effectiveTo === null || period.effectiveTo >= today;
}

/** The periods in the group on `date`, one per organisation, in the order given. */
export function membersOn<T extends MemberPeriod>(periods: readonly T[], date: string): T[] {
  const seen = new Set<string>();
  const found: T[] = [];
  for (const period of periods) {
    if (!coversDate(period, date) || seen.has(period.organisationId)) continue;
    seen.add(period.organisationId);
    found.push(period);
  }
  return found;
}

function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function dayAfter(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export { dayBefore, dayAfter };

/**
 * Why a report from `from` to `to` can't be made with these members, or
 * null when it can: an organisation joined or left the group part-way
 * through. Tohyee doesn't split a member's results at the day it joined or
 * left (that's acquisition and disposal accounting, which isn't built), so
 * the report is refused and names the dates (example CO13).
 */
export function periodCrossesMembership(periods: readonly MemberPeriod[], from: string, to: string, nameOf: (organisationId: string) => string): string | null {
  const problems: string[] = [];
  for (const period of periods) {
    const startsInside = period.effectiveFrom !== null && period.effectiveFrom > from && period.effectiveFrom <= to;
    const endsInside = period.effectiveTo !== null && period.effectiveTo >= from && period.effectiveTo < to;
    if (startsInside) problems.push(`${nameOf(period.organisationId)} joined the group on ${period.effectiveFrom}.`);
    if (endsInside) problems.push(`${nameOf(period.organisationId)} left the group after ${period.effectiveTo}.`);
  }
  if (problems.length === 0) return null;
  return `${problems.join(" ")} Tohyee doesn't split an organisation's results at the day it joined or left, so choose dates on one side of that.`;
}

/**
 * Why a new period for an organisation would clash with its earlier ones,
 * or null. `others` are the organisation's other periods.
 */
export function periodOverlap(next: { effectiveFrom: string | null; effectiveTo: string | null }, others: readonly MemberPeriod[]): string | null {
  if (next.effectiveFrom !== null && next.effectiveTo !== null && next.effectiveTo < next.effectiveFrom) return "The last day can't be before the first day.";
  for (const other of others) {
    const startsBeforeOtherEnds = other.effectiveTo === null || next.effectiveFrom === null || next.effectiveFrom <= other.effectiveTo;
    const endsAfterOtherStarts = next.effectiveTo === null || other.effectiveFrom === null || next.effectiveTo >= other.effectiveFrom;
    if (startsBeforeOtherEnds && endsAfterOtherStarts) {
      return `That overlaps its earlier time in the group (${other.effectiveFrom ?? "the start"} to ${other.effectiveTo ?? "now"}).`;
    }
  }
  return null;
}
