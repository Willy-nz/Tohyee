import { addMonthsToMonthStart } from "@/lib/analytics/date-ranges";
import { financialYearStart, monthEndOf } from "@/lib/financial-year";
import { CUSTOM_REPORT_LIMITS, PERIOD_LENGTHS, type PeriodLength, periodColumns } from "@/lib/reports/custom-layout";
import { columnHeading } from "@/lib/reports/report-dates";

/**
 * The columns of a standard profit and loss or balance sheet compared with
 * earlier periods (decision 1353, examples RX1-RX3), as Xero's "Compare
 * with": the chosen dates first, then each earlier period, newest first,
 * then an optional Total and Year to date (profit and loss only). Whole
 * months, quarters and years use the custom reports' own columns
 * (`periodColumns`, CR2-CR6), so their labels match; other dates move back
 * by the period with the same days (1-20 Jun, 1-20 May).
 *
 * Browser-safe: plain YYYY-MM-DD strings.
 */

export type CompareSetting = {
  /** Earlier periods beside the chosen one: 0 to 11. */
  periods: number;
  periodLength: PeriodLength;
  /** Profit and loss only: the period columns added up. */
  total?: boolean;
  /** Profit and loss only: the start of the financial year to the chosen end date. */
  yearToDate?: boolean;
  /** Profit and loss only: a % of trading income column beside each amount column (RX4). */
  percentOfIncome?: boolean;
};

export type StatementColumnKind = "period" | "total" | "year_to_date" | "percent";

export type StatementColumn = {
  key: string;
  kind: StatementColumnKind;
  label: string;
  /** Null on a balance sheet (as at `to`), and on total and % columns. */
  from: string | null;
  to: string | null;
  /** A % column: the amount column it's worked out from. */
  of?: string;
  /** Where the amount links to: account transactions from this date (a balance sheet column's financial year start). */
  drillFrom?: string | null;
};

export const MAX_COMPARE_PERIODS = CUSTOM_REPORT_LIMITS.periods - 1;

function daysIn(monthStart: string): number {
  return Number(monthEndOf(monthStart).slice(8, 10));
}

/** A date moved back `months` months: a month end stays a month end, other days are kept (or the month's last day). */
export function monthsBefore(date: string, months: number): string {
  const start = addMonthsToMonthStart(date, -months);
  if (date === monthEndOf(date)) return monthEndOf(start);
  const day = Math.min(Number(date.slice(8, 10)), daysIn(start));
  return `${start.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function wholeMonths(from: string, to: string): number | null {
  if (from.slice(8, 10) !== "01" || to !== monthEndOf(to)) return null;
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
}

/** The amount columns (periods, then total and year to date), without the % columns. */
export function compareAmountColumns(
  base: "profit_and_loss" | "balance_sheet",
  range: { from: string | null; to: string },
  setting: CompareSetting,
  yearEndMonth: number,
): StatementColumn[] {
  const months = PERIOD_LENGTHS[setting.periodLength].months;
  const count = setting.periods + 1;
  let periods: StatementColumn[];
  const span = range.from ? wholeMonths(range.from, range.to) : null;
  const asAtMonthEnd = base === "balance_sheet" && range.to === monthEndOf(range.to);
  if ((base === "profit_and_loss" && span === months) || asAtMonthEnd) {
    // Whole periods: the custom reports' columns.
    periods = periodColumns(base, { periodEnd: range.to, periodLength: setting.periodLength, periodCount: count, difference: false, percent: false, yearToDate: false }).map(
      (column) => ({ key: column.key, kind: "period", label: column.label, from: column.from, to: column.to }),
    );
  } else {
    periods = Array.from({ length: count }, (_, index) => {
      const to = monthsBefore(range.to, index * months);
      const from = base === "balance_sheet" || !range.from ? null : monthsBefore(range.from, index * months);
      return { key: `p${index}`, kind: "period" as const, label: columnHeading(from, to), from, to };
    });
  }
  if (base === "balance_sheet") return periods.map((column) => ({ ...column, drillFrom: financialYearStart(column.to!, yearEndMonth) }));
  const columns = periods.map((column) => ({ ...column, drillFrom: column.from }));
  if (setting.total && count > 1) columns.push({ key: "total", kind: "total", label: "Total", from: null, to: null, drillFrom: null });
  if (setting.yearToDate) {
    const from = financialYearStart(range.to, yearEndMonth);
    columns.push({ key: "ytd", kind: "year_to_date", label: "Year to date", from, to: range.to, drillFrom: from });
  }
  return columns;
}

/** All the columns in the order shown: each amount column, then its % column when asked for (RX4). */
export function withPercentColumns(columns: StatementColumn[], percent: boolean): StatementColumn[] {
  if (!percent) return columns;
  return columns.flatMap((column) => [column, { key: `${column.key}_pct`, kind: "percent" as const, label: "%", from: null, to: null, of: column.key }]);
}
