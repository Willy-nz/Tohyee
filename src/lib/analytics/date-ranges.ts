import { addDays, financialYearEnd, financialYearStart, monthEndOf, monthStartOf } from "@/lib/financial-year";

/**
 * Date ranges worked out from today (decisions 577 and 578): the presets
 * beside a dashboard's From and To, and the relative date filters a tile can
 * have. Financial years follow the organisation's balance date (31 March
 * unless it's been changed), and quarters are quarters of that financial
 * year, so with a March balance date they're the usual calendar quarters.
 *
 * Browser-safe: plain YYYY-MM-DD strings, no time zones.
 */

export type DatePreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "this_financial_year"
  | "last_financial_year"
  | "last_12_months"
  | "all_time";

export const DATE_PRESETS: ReadonlyArray<{ value: DatePreset; label: string }> = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "this_financial_year", label: "This financial year" },
  { value: "last_financial_year", label: "Last financial year" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "all_time", label: "All time" },
];

export function isDatePreset(value: unknown): value is DatePreset {
  return typeof value === "string" && DATE_PRESETS.some((preset) => preset.value === value);
}

export type DateRange = { from: string | null; to: string | null };

/** The first day of the month `months` months after (or before) the month a date is in. */
export function addMonthsToMonthStart(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const shiftedYear = year + Math.floor(month / 12);
  const shiftedMonth = ((month % 12) + 12) % 12;
  return `${String(shiftedYear).padStart(4, "0")}-${String(shiftedMonth + 1).padStart(2, "0")}-01`;
}

/** Months from one month start to another: 2026-04-01 to 2026-10-01 is 6. */
function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/** The quarter of the financial year that `today` is in. */
export function financialQuarter(today: string, yearEndMonth: number): { from: string; to: string } {
  const yearStart = financialYearStart(today, yearEndMonth);
  const from = addMonthsToMonthStart(yearStart, Math.floor(monthsBetween(yearStart, monthStartOf(today)) / 3) * 3);
  return { from, to: addDays(addMonthsToMonthStart(from, 3), -1) };
}

/** A preset's dates, as of `today`. "All time" has no dates. */
export function presetRange(preset: DatePreset, today: string, yearEndMonth: number): DateRange {
  switch (preset) {
    case "this_month":
      return { from: monthStartOf(today), to: monthEndOf(today) };
    case "last_month": {
      const from = addMonthsToMonthStart(today, -1);
      return { from, to: monthEndOf(from) };
    }
    case "this_quarter":
      return financialQuarter(today, yearEndMonth);
    case "this_financial_year":
      return { from: financialYearStart(today, yearEndMonth), to: financialYearEnd(today, yearEndMonth) };
    case "last_financial_year": {
      const lastDay = addDays(financialYearStart(today, yearEndMonth), -1);
      return { from: financialYearStart(lastDay, yearEndMonth), to: lastDay };
    }
    case "last_12_months":
      return lastMonths(12, today);
    case "all_time":
      return { from: null, to: null };
  }
}

/** The preset whose dates these are today, if any (so the picker can show it). */
export function matchingPreset(range: DateRange, today: string, yearEndMonth: number): DatePreset | null {
  const from = range.from || null;
  const to = range.to || null;
  return DATE_PRESETS.find((preset) => {
    const dates = presetRange(preset.value, today, yearEndMonth);
    return dates.from === from && dates.to === to;
  })?.value ?? null;
}

/** The last `days` days, today included. */
export function lastDays(days: number, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

/**
 * The last `months` months: this month so far and the whole months before it,
 * so a chart by month has no part month at the start. 12 months on
 * 20 October 2026 is 1 November 2025 to 20 October 2026.
 */
export function lastMonths(months: number, today: string): { from: string; to: string } {
  return { from: addMonthsToMonthStart(today, -(months - 1)), to: today };
}
