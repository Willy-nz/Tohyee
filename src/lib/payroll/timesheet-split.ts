import { ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import {
  abs,
  add,
  cmp,
  dec,
  type Decimal,
  divide,
  divideTruncated,
  isNegative,
  isPositive,
  isZero,
  mul,
  neg,
  parseDecimalInput,
  significantScale,
  sub,
  sum,
  toFixedString,
  toPlainString,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";
import { daysBetween, enteredAfterText, isEnteredLate } from "@/lib/rd/amounts";

/**
 * Timesheet rules that don't touch the database (payroll stage P9; examples
 * TS2, TS3 and TS5-TS8; decisions 92-94, 98, 100). Browser-safe: the
 * timesheet screen uses the same week and hours rules as the server.
 */

const HUNDRED = dec("100");
const MAX_HOURS = dec("24");
const CENT = dec("0.01");

/** The names of ISO weekdays, 1 = Monday to 7 = Sunday. */
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** A date's ISO weekday: 1 = Monday to 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** True for a Monday. */
export function isMonday(date: string): boolean {
  return isoWeekday(date) === 1;
}

/** True when the date is the first day of a timesheet week (decision 192: the organisation's first day, Monday unless changed). */
export function isWeekStart(date: string, firstDay = 1): boolean {
  return isoWeekday(date) === firstDay;
}

/** The first day of the timesheet week a date is in (decision 192; Monday unless the organisation's first day is another). */
export function weekStartOf(date: string, firstDay = 1): string {
  return addDays(date, -((isoWeekday(date) - firstDay + 7) % 7));
}

/** The 7 dates of the week starting `weekStart`. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

/** One cell's hours: more than 0, at most 24, at most 2 decimal places (decision 93; TS11). */
export function parseTimesheetHours(input: unknown, label: string): string {
  const value = parseDecimalInput(input, `${label} hours`, { maxScale: 2 });
  if (cmp(dec(value), MAX_HOURS) > 0) throw new ValidationError(`${label} hours can't be more than 24.`);
  return toFixedString(dec(value), 2);
}

/** How long after the work an entry was made, flagged after 14 days (decision 38; TS3). */
export function timesheetLateness(workDate: string, enteredOn: string): { days: number; late: boolean; text: string } {
  const days = daysBetween(workDate, enteredOn);
  return { days, late: isEnteredLate(days), text: enteredAfterText(days) };
}

/** Entries on days inside the pay period (decision 98). */
export function coveredHoursOnly<T extends { workDate: string }>(entries: readonly T[], periodStart: string, periodEnd: string): T[] {
  return entries.filter((entry) => entry.workDate >= periodStart && entry.workDate <= periodEnd);
}

export type WeightSource = "timesheet" | "allocation";

export type TimesheetWeightInput = {
  /** Days in the pay period (P). */
  periodDays: number;
  /** Days of the period in approved timesheets' weeks (c). */
  coveredDays: number;
  /** Covered hours per timesheet row (hₜ), in the order they're split. */
  rows: ReadonlyArray<{ key: string; hours: string }>;
  /** Covered hours on "other work" (h₀), spread by the allocation. */
  otherHours: string;
  /** The default allocation's lines in effect on the pay date. */
  allocation: ReadonlyArray<{ key: string; percentage: string }>;
};

/**
 * Each share's weight (decision 98; TS5, TS6): a timesheet row c × hₜ × 100,
 * an allocation line ((P − c) × H + c × h₀) × its %, where H is all covered
 * hours. The weights add up to P × H × 100. With no covered hours the
 * allocation's percentages are the weights. Shares with no weight are left
 * out.
 */
export function timesheetWeights(input: TimesheetWeightInput): Array<{ key: string; source: WeightSource; weight: string }> {
  const other = dec(input.otherHours);
  const totalHours = add(sum(input.rows.map((row) => dec(row.hours))), other);
  if (input.coveredDays <= 0 || !isPositive(totalHours)) {
    return input.allocation
      .filter((line) => isPositive(dec(line.percentage)))
      .map((line) => ({ key: line.key, source: "allocation" as const, weight: toPlainString(dec(line.percentage)) }));
  }
  const covered = dec(String(input.coveredDays));
  const uncovered = dec(String(input.periodDays - input.coveredDays));
  const result: Array<{ key: string; source: WeightSource; weight: string }> = [];
  for (const row of input.rows) {
    const weight = mul(mul(covered, dec(row.hours)), HUNDRED);
    if (isPositive(weight)) result.push({ key: row.key, source: "timesheet", weight: toPlainString(weight) });
  }
  const allocationBase = add(mul(uncovered, totalHours), mul(covered, other));
  for (const line of input.allocation) {
    const weight = mul(allocationBase, dec(line.percentage));
    if (isPositive(weight)) result.push({ key: line.key, source: "allocation", weight: toPlainString(weight) });
  }
  return result;
}

/**
 * Splits `amount` (at most 2 decimal places) in proportion to positive
 * `weights` into parts that add back to exactly the amount: each exact share
 * cut to cents, then the cents left over one each to the shares with the
 * largest part cut off, the earlier share first on a tie (PE3's rule). With
 * weights that are percentages totalling 100 it gives exactly
 * `splitByPercentages`. A negative amount mirrors the positive split.
 */
export function splitByWeights(amount: string, weights: readonly string[]): string[] {
  const value = dec(amount);
  if (significantScale(value) > 2) throw new ValidationError("The amount to split can have at most 2 decimal places.");
  if (weights.length === 0) throw new ValidationError("There's nothing to split the amount by.");
  const parsed = weights.map((weight) => dec(weight));
  if (parsed.some((weight) => !isPositive(weight))) throw new ValidationError("Each share's weight must be more than 0.");
  const total = sum(parsed);
  const whole = abs(value);
  const numerators = parsed.map((weight) => mul(whole, weight));
  const parts = numerators.map((numerator) => divideTruncated(numerator, total, 2));
  // What was cut off, times the total: compared exactly, with no rounding.
  const cutOff = numerators.map((numerator, index) => sub(numerator, mul(parts[index], total)));
  let leftOver = sub(whole, sum(parts));
  const order = cutOff
    .map((remainder, index) => ({ remainder, index }))
    .sort((left, right) => cmp(right.remainder, left.remainder) || left.index - right.index);
  for (const { index } of order) {
    if (cmp(leftOver, CENT) < 0) break;
    parts[index] = add(parts[index], CENT);
    leftOver = sub(leftOver, CENT);
  }
  return parts.map((part: Decimal) => toFixedString(isNegative(value) ? neg(part) : part, 2));
}

/** A share of `cost` for R&D: cost × weight ÷ total, rounded down (decision 50; TS7). */
export function weightShareRoundedDown(cost: string, weight: string, total: string, scale: number): string {
  if (isZero(dec(total))) return toFixedString(ZERO_DECIMAL, scale);
  return toFixedString(divideTruncated(mul(dec(cost), dec(weight)), dec(total), scale), scale);
}

/** A share's percentage of the whole, half up to 4 places, for display (decision 101). */
export function percentageOfWeight(weight: string, total: string): string {
  if (isZero(dec(total))) return "0.0000";
  return toFixedString(divide(mul(dec(weight), HUNDRED), dec(total), 4), 4);
}
