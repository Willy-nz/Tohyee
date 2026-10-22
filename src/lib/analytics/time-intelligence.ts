import { ValidationError } from "@/lib/errors";
import { financialQuarter, lastMonths } from "@/lib/analytics/date-ranges";
import { financialYearStart, monthStartOf } from "@/lib/financial-year";
import type { Grain } from "@/lib/analytics/query";

/**
 * Time intelligence (#376 phase 4, decision 771; Power BI's TOTALYTD,
 * TOTALQTD, TOTALMTD, SAMEPERIODLASTYEAR and DATESINPERIOD as the
 * references). A value can be worked out over the year, quarter or month to
 * date, or the last 12 months, by the organisation's balance date: as at the
 * dashboard's To date for one total or groups that aren't dates, and as at
 * the end of each period on a chart by date.
 */
export type TimePeriod = "ytd" | "qtd" | "mtd" | "rolling_12";

export const TIME_PERIODS: ReadonlyArray<{ value: TimePeriod; label: string; suffix: string }> = [
  { value: "ytd", label: "Financial year to date", suffix: "year to date" },
  { value: "qtd", label: "Financial quarter to date", suffix: "quarter to date" },
  { value: "mtd", label: "Month to date", suffix: "month to date" },
  { value: "rolling_12", label: "Last 12 months", suffix: "last 12 months" },
];

/**
 * The dates a period covers, as at `asAt`: from the start of the financial
 * year (or financial quarter, or month) it's in, or the last 12 months as
 * the "Last 12 months" dates are (this month so far and the 11 before it).
 */
export function periodRange(period: TimePeriod, asAt: string, yearEndMonth: number): { from: string; to: string } {
  switch (period) {
    case "ytd":
      return { from: financialYearStart(asAt, yearEndMonth), to: asAt };
    case "qtd":
      return { from: financialQuarter(asAt, yearEndMonth).from, to: asAt };
    case "mtd":
      return { from: monthStartOf(asAt), to: asAt };
    case "rolling_12":
      return lastMonths(12, asAt);
  }
}

/** How far back a chart by date reads so its first period's year (quarter, month or 12 months) to date is whole. */
export function periodStart(period: TimePeriod, from: string, yearEndMonth: number): string {
  return periodRange(period, from, yearEndMonth).from;
}

const FINE: Record<TimePeriod, Grain[]> = {
  ytd: ["day", "week", "month", "quarter", "fquarter"],
  qtd: ["day", "week", "month"],
  mtd: ["day", "week"],
  rolling_12: ["day", "week", "month", "quarter", "fquarter"],
};

export type PeriodTarget = {
  label: string;
  aggregate: string;
  inputAggregates: string[];
  balance: boolean;
  currency: boolean;
  compare?: string;
  quick: boolean;
  dated: boolean;
};

const ADDED_UP = new Set(["sum", "count"]);

/** Checks a value's period, or explains why it can't have it. */
export function parsePeriod(raw: unknown, target: PeriodTarget, place: { grain: Grain | null; pivot: boolean; breakdown: boolean }): TimePeriod | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === "none") return undefined;
  const label = target.label;
  const period = TIME_PERIODS.find((entry) => entry.value === raw)?.value;
  if (!period) throw new ValidationError(`${label}: choose year, quarter or month to date, or the last 12 months.`);
  const name = TIME_PERIODS.find((entry) => entry.value === period)!.suffix;
  if (place.pivot) throw new ValidationError(`${label}: a pivot table can't show ${name} yet; use a table or chart.`);
  if (!target.dated) throw new ValidationError(`${label}: ${name} needs a date the dashboard's dates apply to.`);
  if (target.quick) throw new ValidationError(`${label}: a value can have ${name} or a quick calculation, not both.`);
  if (target.balance) throw new ValidationError(`${label}: a balance is already as at its date, so it has no ${name}.`);
  if (place.grain) {
    if (!FINE[period].includes(place.grain)) throw new ValidationError(`${label}: ${name} needs the dates grouped by a shorter period than this.`);
    if (place.breakdown) throw new ValidationError(`${label}: a chart with a second grouping can't show ${name} yet.`);
    if (target.compare) throw new ValidationError(`${label}: on a chart by date, ${name} can't also compare with last year; add the value again for last year, or use a key figure or a table that isn't grouped by date.`);
    if (target.currency) throw new ValidationError(`${label}: its rows are in more than one currency, so ${name} would add different currencies.`);
    const addsUp = target.aggregate === "formula" ? target.inputAggregates.every((aggregate) => ADDED_UP.has(aggregate)) : ADDED_UP.has(target.aggregate);
    if (!addsUp) throw new ValidationError(`${label}: on a chart by date, ${name} adds periods up, which only works for a total or a count (or a formula of them).`);
  }
  if (target.compare === "previous_period") throw new ValidationError(`${label}: ${name} compares with the same period last year, not the period before.`);
  return period;
}

/** What a period means for a value, in words (decision 771). */
export function describePeriod(period: TimePeriod, options: { grouped: boolean; dated: boolean }): string {
  const what = {
    ytd: "from the start of the financial year (the organisation's balance date)",
    qtd: "from the start of the financial quarter (quarters run from the balance date)",
    mtd: "from the start of the month",
    rolling_12: "over the last 12 months (that month so far and the 11 whole months before it)",
  }[period];
  return options.dated
    ? `each period shows the value ${what} to the end of that period, including rows before the dashboard's From date; a new financial year starts again from nothing`
    : `worked out ${what} to the dashboard's To date (or today), whatever the From date${options.grouped ? " (for each group when grouped)" : ""}; "and last year" is the same dates a year before (29 February becomes 28 February)`;
}
