/**
 * Financial years end on the last day of a chosen month. New Zealand's
 * standard balance date is 31 March, so that's the default.
 *
 * Browser-safe: no server imports.
 */
export const DEFAULT_FINANCIAL_YEAR_END_MONTH = 3;

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function isFinancialYearEndMonth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12;
}

/**
 * First day (YYYY-MM-DD) of the financial year that contains `date`.
 * With a March year end: 2026-03-31 -> 2025-04-01, 2026-04-01 -> 2026-04-01.
 */
export function financialYearStart(date: string, yearEndMonth: number): string {
  if (!isFinancialYearEndMonth(yearEndMonth)) {
    throw new Error(`Invalid financial year end month: ${yearEndMonth}`);
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startMonth = (yearEndMonth % 12) + 1;
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`;
}

/** The date `days` days after (or before, when negative) a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** First day of the month a date is in: 2026-06-15 -> 2026-06-01. */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Last day of the month a date is in: 2026-02-10 -> 2026-02-28. */
export function monthEndOf(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Whether a date is the last day of its month. */
export function isMonthEndDate(date: string): boolean {
  return monthEndOf(date) === date;
}

/**
 * Last day of the financial year that contains `date`.
 * With a March year end: 2025-07-10 -> 2026-03-31, 2026-04-01 -> 2027-03-31.
 */
export function financialYearEnd(date: string, yearEndMonth: number): string {
  const start = financialYearStart(date, yearEndMonth);
  const nextStart = `${String(Number(start.slice(0, 4)) + 1).padStart(4, "0")}${start.slice(4)}`;
  return addDays(nextStart, -1);
}

/** "June 2026" for any date in June 2026. */
export function monthLabel(date: string): string {
  return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}
