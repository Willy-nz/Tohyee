import { addDays } from "@/lib/financial-year";

/**
 * Date helpers for Holidays Act leave (payroll stage P8). Dates are
 * YYYY-MM-DD strings, as everywhere in Tohyee. Browser-safe.
 */

export { addDays };

/** The date `months` calendar months after (or before) a date; the 31st becomes the month's last day (31 Jan + 1 month = 28 Feb). */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to − from): daysBetween("2026-04-06", "2027-02-15") is 315. */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  });
  return Math.round((b - a) / 86_400_000);
}

/** Days from `from` to `to` inclusive (both ends), or 0 when `to` is before `from`. */
export function daysInclusive(from: string, to: string): number {
  return to < from ? 0 : daysBetween(from, to) + 1;
}

/** 0 = Monday … 6 = Sunday (the order of a usual week). */
export function weekdayIndex(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) days.push(date);
  return days;
}

/** The later of two dates. */
export function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/** The earlier of two dates. */
export function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}
