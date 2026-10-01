import { splitByPercentages } from "@/lib/payroll/allocation-split";
import { add, dec, type Decimal, divide, divideTruncated, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Workforce budget maths (payroll stage P11; examples WB1-WB2, decisions
 * 114-118). Browser-safe: no server imports.
 */

export const WORKFORCE_LIMITS = { months: 24, lines: 500, nameLength: 100, splitLines: 20, rises: 24 } as const;

export type WorkforcePayBasis = "salary" | "hourly";

/** A pay rate from a month on: the annual salary or the hourly rate. */
export type WorkforceRate = { fromMonth: string; rate: string };

export type WorkforceLineMaths = {
  payBasis: WorkforcePayBasis;
  /** Salary: FTE (more than 0, at most 1). */
  fte: string | null;
  /** Hourly: hours a week. */
  hoursPerWeek: string | null;
  /** The first is from the line's start month; later ones are pay rises. */
  rates: readonly WorkforceRate[];
  /** Employer KiwiSaver rate, percent (0 for none). */
  kiwiSaverRate: string;
  startMonth: string;
  endMonth: string | null;
};

const TWELVE = dec("12");
const WEEKS = dec("52");
const HUNDRED = dec("100");

/** The rate in effect in `month`: the latest whose month is on or before it. */
export function rateForMonth(rates: readonly WorkforceRate[], month: string): string | null {
  let found: string | null = null;
  for (const rate of [...rates].sort((a, b) => a.fromMonth.localeCompare(b.fromMonth))) {
    if (rate.fromMonth <= month) found = rate.rate;
  }
  return found;
}

/** Whether the line runs in `month` (whole months, decision 114). */
export function lineActiveIn(line: Pick<WorkforceLineMaths, "startMonth" | "endMonth">, month: string): boolean {
  return month >= line.startMonth && (line.endMonth === null || month <= line.endMonth);
}

/**
 * One month's wages for a line, rounded once, half up, to the cent
 * (decision 115): salary × FTE ÷ 12, or hourly rate × hours × 52 ÷ 12.
 */
export function monthlyWages(line: Pick<WorkforceLineMaths, "payBasis" | "fte" | "hoursPerWeek">, rate: string): string {
  const annual = line.payBasis === "salary" ? mul(dec(rate), dec(line.fte ?? "1")) : mul(mul(dec(rate), dec(line.hoursPerWeek ?? "0")), WEEKS);
  return toFixedString(divide(annual, TWELVE, 2), 2);
}

/** Employer KiwiSaver on a month's wages: wages × rate, truncated to the cent as pay runs do (decision 118). */
export function monthlyKiwiSaver(wages: string, ratePercent: string): string {
  return toFixedString(divideTruncated(mul(dec(wages), dec(ratePercent)), HUNDRED, 2), 2);
}

export type MonthFigures = { month: string; wages: string; kiwiSaver: string };

/** A line's wages and KiwiSaver for each of `months` (0.00 outside its months). */
export function lineFigures(line: WorkforceLineMaths, months: readonly string[]): MonthFigures[] {
  return months.map((month) => {
    const rate = lineActiveIn(line, month) ? rateForMonth(line.rates, month) : null;
    if (rate === null) return { month, wages: "0.00", kiwiSaver: "0.00" };
    const wages = monthlyWages(line, rate);
    return { month, wages, kiwiSaver: monthlyKiwiSaver(wages, line.kiwiSaverRate) };
  });
}

/** A month's wages and KiwiSaver split by `percentages` (PE3), in the same order. */
export function splitMonth(figures: MonthFigures, percentages: readonly string[]): Array<{ wages: string; kiwiSaver: string }> {
  const wages = splitByPercentages(figures.wages, percentages);
  const kiwiSaver = splitByPercentages(figures.kiwiSaver, percentages);
  return percentages.map((_, index) => ({ wages: wages[index], kiwiSaver: kiwiSaver[index] }));
}

/** Adds money strings exactly. */
export function addMoney(values: readonly string[]): string {
  let total: Decimal = ZERO_DECIMAL;
  for (const value of values) total = add(total, dec(value));
  return toFixedString(total, 2);
}
