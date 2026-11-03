import { addMonthsToMonthStart, financialQuarter, presetRange } from "@/lib/analytics/date-ranges";
import { addDays, financialYearEnd, financialYearStart, MONTH_NAMES, monthEndOf, monthStartOf } from "@/lib/financial-year";

/**
 * Dates for the standard reports' toolbar (decision 1350): Xero's presets
 * (This month, Last month, This quarter, Last quarter, This financial year,
 * Last financial year, or your own dates), and the statement wording under a
 * report's title ("For the month ended 31 October 2026", "As at 4 November
 * 2026"). Quarters are quarters of the financial year, as on dashboards
 * (decision 577), so with a March balance date they're calendar quarters.
 *
 * Browser-safe: plain YYYY-MM-DD strings.
 */

export type ReportDatePreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_financial_year"
  | "last_financial_year"
  | "custom";

export const REPORT_DATE_PRESETS: ReadonlyArray<{ value: ReportDatePreset; label: string; asAtLabel: string }> = [
  { value: "this_month", label: "This month", asAtLabel: "End of this month" },
  { value: "last_month", label: "Last month", asAtLabel: "End of last month" },
  { value: "this_quarter", label: "This quarter", asAtLabel: "End of this quarter" },
  { value: "last_quarter", label: "Last quarter", asAtLabel: "End of last quarter" },
  { value: "this_financial_year", label: "This financial year", asAtLabel: "End of this financial year" },
  { value: "last_financial_year", label: "Last financial year", asAtLabel: "End of last financial year" },
  { value: "custom", label: "Custom dates", asAtLabel: "Custom date" },
];

export type ReportRange = { from: string; to: string };

/** A preset's first and last day, as of `today`. */
export function reportPresetRange(preset: Exclude<ReportDatePreset, "custom">, today: string, yearEndMonth: number): ReportRange {
  if (preset === "last_quarter") {
    const thisQuarter = financialQuarter(today, yearEndMonth);
    const from = addMonthsToMonthStart(thisQuarter.from, -3);
    return { from, to: addDays(thisQuarter.from, -1) };
  }
  const range = presetRange(preset, today, yearEndMonth);
  return { from: range.from!, to: range.to! };
}

/** The preset that gives exactly these dates today, or "custom". As-at reports compare the end date only. */
export function reportPresetFor(range: { from: string | null; to: string }, today: string, yearEndMonth: number, asAt = false): ReportDatePreset {
  for (const preset of REPORT_DATE_PRESETS) {
    if (preset.value === "custom") continue;
    const dates = reportPresetRange(preset.value, today, yearEndMonth);
    if (dates.to === range.to && (asAt || dates.from === range.from)) return preset.value;
  }
  return "custom";
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(date: string) {
  return { year: date.slice(0, 4), month: Number(date.slice(5, 7)) - 1, day: Number(date.slice(8, 10)) };
}

/** "4 November 2026". */
export function longDate(date: string): string {
  const { year, month, day } = parts(date);
  return `${day} ${MONTH_NAMES[month]} ${year}`;
}

/**
 * The statement's period line, as Xero words it: a whole month is "For the
 * month ended 31 October 2026", a whole financial year "For the year ended
 * 31 March 2027", anything else "For the period 1 June 2026 to 4 November
 * 2026".
 */
export function statementPeriod(from: string, to: string, yearEndMonth?: number | null): string {
  if (from === monthStartOf(to) && to === monthEndOf(to)) return `For the month ended ${longDate(to)}`;
  if (yearEndMonth && from === financialYearStart(to, yearEndMonth) && to === financialYearEnd(to, yearEndMonth)) {
    return `For the year ended ${longDate(to)}`;
  }
  return `For the period ${longDate(from)} to ${longDate(to)}`;
}

/** "As at 4 November 2026". */
export function statementAsAt(asAt: string): string {
  return `As at ${longDate(asAt)}`;
}

/**
 * The amount column's heading: "Oct 2026" for a whole month, "1-20 Jun 2026"
 * within a month, "1 Jun-4 Nov 2026" for other dates in one year, "1 Jun 2026-4 Nov 2027" across years,
 * and "4 Nov 2026" for an as-at report (pass the same date twice).
 */
export function columnHeading(from: string | null, to: string): string {
  const end = parts(to);
  if (!from || from === to) return `${end.day} ${SHORT_MONTHS[end.month]} ${end.year}`;
  if (from === monthStartOf(to) && to === monthEndOf(to)) return `${SHORT_MONTHS[end.month]} ${end.year}`;
  const start = parts(from);
  if (start.year === end.year && start.month === end.month) return `${start.day}-${end.day} ${SHORT_MONTHS[end.month]} ${end.year}`;
  if (start.year === end.year) return `${start.day} ${SHORT_MONTHS[start.month]}-${end.day} ${SHORT_MONTHS[end.month]} ${end.year}`;
  return `${start.day} ${SHORT_MONTHS[start.month]} ${start.year}-${end.day} ${SHORT_MONTHS[end.month]} ${end.year}`;
}

/**
 * When a report was produced, in New Zealand time, e.g. "4 Nov 2026, 9:05
 * am". Used on exports, which are made on the server (whose clock may be
 * UTC), so the time zone is always stated rather than taken from the server.
 */
export function producedAtText(iso: string, timeZone = "Pacific/Auckland"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-NZ", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(/ /g, " ");
}
