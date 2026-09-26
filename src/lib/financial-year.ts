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
