/**
 * The period a key figure is compared with (#334, decision 594). Dates are
 * YYYY-MM-DD strings, worked out in UTC so a time zone can't move them.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Moves a date by whole months, keeping the day where the month has it (31 Mar less a month is 28 or 29 Feb). */
export function addMonths(date: string, months: number): string {
  const day = parse(date);
  const target = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + months, 1));
  const lastDay = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth());
  target.setUTCDate(Math.min(day.getUTCDate(), lastDay));
  return format(target);
}

function addDays(date: string, days: number): string {
  const day = parse(date);
  day.setUTCDate(day.getUTCDate() + days);
  return format(day);
}

function isFirstOfMonth(date: string): boolean {
  return date.endsWith("-01");
}

function isLastOfMonth(date: string): boolean {
  const day = parse(date);
  return day.getUTCDate() === lastDayOfMonth(day.getUTCFullYear(), day.getUTCMonth());
}

export type Period = { from: string; to: string };

function valid(from: string | null | undefined, to: string | null | undefined): from is string {
  return typeof from === "string" && typeof to === "string" && DATE.test(from) && DATE.test(to) && from <= to;
}

/**
 * The period just before, the same length. Whole months move back by that
 * many months (October 2026 is compared with September; the year to 31 March
 * with the year before); any other range moves back by its number of days.
 * Without both dates there's nothing to compare with.
 */
export function previousPeriod(from: string | null | undefined, to: string | null | undefined): Period | null {
  if (!valid(from, to)) return null;
  if (isFirstOfMonth(from) && isLastOfMonth(to!)) {
    const start = parse(from);
    const end = parse(to!);
    const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1;
    const previousFrom = addMonths(from, -months);
    const previousEnd = parse(addMonths(from, -1));
    return { from: previousFrom, to: format(new Date(Date.UTC(previousEnd.getUTCFullYear(), previousEnd.getUTCMonth(), lastDayOfMonth(previousEnd.getUTCFullYear(), previousEnd.getUTCMonth())))) };
  }
  const days = Math.round((parse(to!).getTime() - parse(from).getTime()) / 86_400_000) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** The same dates a year before (29 February becomes 28 February; a range ending on a month's last day ends on that month's last day). */
export function previousYear(from: string | null | undefined, to: string | null | undefined): Period | null {
  if (!valid(from, to)) return null;
  const end = isLastOfMonth(to!)
    ? (() => {
        const day = parse(addMonths(to!, -12));
        return format(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), lastDayOfMonth(day.getUTCFullYear(), day.getUTCMonth()))));
      })()
    : addMonths(to!, -12);
  return { from: addMonths(from, -12), to: end };
}
