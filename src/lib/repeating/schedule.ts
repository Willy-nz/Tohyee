/**
 * When a repeating invoice falls due (examples RI1, RI5, RI6), browser-safe
 * so the editor shows the same dates the server makes.
 *
 * - Every N weeks: the start date plus 7 x N days each time.
 * - Every N months: the start date's day in every Nth month from the start;
 *   a day the month doesn't have becomes its last day (the 31st falls on
 *   30 April and 28 or 29 February), and the next month goes back to the 31st.
 *
 * Each date is worked out from the start date, never from the date before,
 * so a short month doesn't pull later dates earlier.
 */
export const REPEAT_PERIODS = ["week", "month"] as const;
export type RepeatPeriod = (typeof REPEAT_PERIODS)[number];

export type RepeatSchedule = {
  period: RepeatPeriod;
  every: number;
  startDate: string;
  endDate: string | null;
};

function parts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return [year, month, day];
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The nth date of the schedule (0 is the start date). */
export function occurrence(schedule: Pick<RepeatSchedule, "period" | "every" | "startDate">, n: number): string {
  const [year, month, day] = parts(schedule.startDate);
  if (schedule.period === "week") {
    const moved = new Date(Date.UTC(year, month - 1, day + 7 * schedule.every * n));
    return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
  }
  const monthIndex = month - 1 + schedule.every * n;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  return iso(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/**
 * The schedule's dates from `from` to `to` (both included, YYYY-MM-DD), in
 * order, stopping at the end date. At most `limit` dates.
 */
export function datesBetween(schedule: RepeatSchedule, from: string, to: string, limit = 1000): string[] {
  const dates: string[] = [];
  for (let n = 0; dates.length < limit; n += 1) {
    const date = occurrence(schedule, n);
    if (date > to || (schedule.endDate !== null && date > schedule.endDate)) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}

/** The next date on or after `from`, or null when the schedule has ended by then. */
export function nextDate(schedule: RepeatSchedule, from: string): string | null {
  for (let n = 0; n < 100_000; n += 1) {
    const date = occurrence(schedule, n);
    if (schedule.endDate !== null && date > schedule.endDate) return null;
    if (date >= from) return date;
  }
  return null;
}

/** "Every month", "Every 2 weeks". */
export function describeSchedule(schedule: Pick<RepeatSchedule, "period" | "every">): string {
  return schedule.every === 1 ? `Every ${schedule.period}` : `Every ${schedule.every} ${schedule.period}s`;
}
