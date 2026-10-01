import { ValidationError } from "@/lib/errors";
import { cmp, dec, isNegative, isPositive, isZero } from "@/lib/money/decimal";
import { addMonths, addDays, daysInclusive } from "./dates";
import { annualEntitlementDates, type UnpaidLeave } from "./annual";
import { sickEntitlementDates } from "./sick";
import type { PeriodEarnings } from "./earnings";
import { refuse } from "./rules";

/**
 * Opening leave balances (decision 168; examples HL43-HL48): an employee's
 * leave and earlier earnings from another payroll, as at the end of the
 * opening date, the last day before the first pay period whose leave
 * Tohyee keeps. Tohyee then treats them as its own records: the balances at
 * the opening date, later entitlements from the last entitlement date
 * (s 16(1)) and the start date (s 63(2)(a)), and the earnings rows inside
 * AWE, ADP, four-week and 8% windows. Pure and exact. Browser-safe.
 */

/** One pay period of the previous payroll (as Xero asks for them): gross earnings (s 14), the irregular part (s 8(2) "b"), days worked or on paid leave (s 9A(2)). */
export type OpeningEarningsRow = {
  periodStart: string;
  periodEnd: string;
  gross: string;
  irregular: string;
  days: number;
};

export type OpeningBalanceFigures = {
  asAt: string;
  /** Annual holidays in weeks (negative when taken in advance). */
  annualWeeks: string;
  annualLastEntitled: string | null;
  /** Weeks already cashed up in the entitlement year the opening date is in (s 28A(2)(b)). */
  annualCashedUpWeeks: string;
  /** Holiday pay already paid for annual holidays taken in advance since the last entitlement (s 23(2)(a), s 25(2)(a)). */
  annualAdvancePaid: string;
  sickDays: string;
  familyViolenceDays: string;
  /** The dates untaken alternative holidays arose (s 81(2)(k)). */
  alternativeHolidays: string[];
  earnings: OpeningEarningsRow[];
};

/**
 * Checks opening balances before they're saved (decision 168; HL48).
 * `approvedPeriods` are the employee's approved pay periods in Tohyee:
 * the rows can't overlap them and run without gaps to the opening date, or
 * to the day before the first of them on or before it.
 */
export function checkOpeningBalances(input: {
  figures: OpeningBalanceFigures;
  startDate: string;
  finishDate: string | null;
  unpaid: readonly UnpaidLeave[];
  approvedPeriods: ReadonlyArray<{ periodStart: string; periodEnd: string }>;
}): void {
  const { figures } = input;
  const asAt = figures.asAt;
  if (asAt < input.startDate) throw new ValidationError(`The opening date can't be before the employee started (${input.startDate}).`);
  if (input.finishDate && asAt >= input.finishDate) throw new ValidationError("The opening date must be before the employee's last day.");

  // Annual holidays (s 16, s 28A, s 23, s 25).
  const annual = dec(figures.annualWeeks);
  const advance = dec(figures.annualAdvancePaid);
  if (isNegative(advance)) throw new ValidationError("Holiday pay paid in advance can't be negative.");
  if (isNegative(annual) && !isPositive(advance)) {
    throw new ValidationError("The annual holiday balance is negative (taken in advance): give the holiday pay already paid for those holidays (s 23(2)(a), s 25(2)(a)).");
  }
  if (!isNegative(annual) && !isZero(advance)) throw new ValidationError("Holiday pay paid in advance goes with a negative annual holiday balance only.");
  const cashedUp = dec(figures.annualCashedUpWeeks);
  if (isNegative(cashedUp) || cmp(cashedUp, dec("1")) > 0) throw new ValidationError("Weeks cashed up in the entitlement year are from 0 to 1 (s 28A(2)(b)).");
  const last = figures.annualLastEntitled;
  const fromStart = annualEntitlementDates(input.startDate, input.unpaid, asAt);
  if (last) {
    if (last > asAt) throw new ValidationError("The date last entitled to annual holidays must be on or before the opening date.");
    if (last < addMonths(input.startDate, 12)) throw new ValidationError("The date last entitled to annual holidays can't be before 12 months' employment (s 16(1)).");
  } else {
    if (fromStart.length > 0) {
      throw new ValidationError(`Give the date last entitled to annual holidays: 12 months from the start was ${fromStart[0]}, on or before the opening date.`);
    }
    if (!isZero(cashedUp)) throw new ValidationError("Annual holidays can't have been cashed up before any entitlement (s 28A(1)).");
    if (isPositive(annual)) throw new ValidationError("Before 12 months' employment there's no annual holiday entitlement (s 16(1)): the balance is 0, or negative if taken in advance.");
  }

  // Sick and family violence leave before 6 months: nothing yet, or less than nothing if taken in advance (s 63(3), s 72D(3)).
  if (sickEntitlementDates(input.startDate, asAt).length === 0) {
    if (isPositive(dec(figures.sickDays)) || isPositive(dec(figures.familyViolenceDays))) {
      throw new ValidationError("Before 6 months' employment there's no sick or family violence leave entitlement (s 63(1)(a), s 72D): the balances are 0, or negative if taken in advance.");
    }
  }

  // Alternative holidays arise on public holidays worked before the opening date.
  const seen = new Set<string>();
  for (const date of figures.alternativeHolidays) {
    if (date < input.startDate || date > asAt) throw new ValidationError(`An alternative holiday that arose on ${date} must have arisen between the start date and the opening date.`);
    if (seen.has(date)) throw new ValidationError(`Only one alternative holiday can arise on ${date}.`);
    seen.add(date);
  }

  // Earnings rows: by pay period, without gaps, up to the opening date or Tohyee's own pay periods.
  const rows = [...figures.earnings].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
  if (rows.length === 0) throw new ValidationError("Give the earnings for each pay period before the opening date (at least the last 12 months, or since the start).");
  if (rows.length > 400) throw new ValidationError("At most 400 earnings rows.");
  const firstTohyee = input.approvedPeriods.filter((period) => period.periodStart <= asAt).reduce<string | null>((first, period) => (!first || period.periodStart < first ? period.periodStart : first), null);
  const rowsEnd = firstTohyee ? addDays(firstTohyee, -1) : asAt;
  for (const [index, row] of rows.entries()) {
    if (row.periodEnd < row.periodStart) throw new ValidationError(`The earnings row from ${row.periodStart} ends before it starts.`);
    if (daysInclusive(row.periodStart, row.periodEnd) > 31) throw new ValidationError(`The earnings row from ${row.periodStart} is longer than a month: enter one row per pay period.`);
    if (row.periodStart < input.startDate) throw new ValidationError(`The earnings row from ${row.periodStart} starts before the employee did.`);
    if (row.periodEnd > rowsEnd) {
      throw new ValidationError(
        firstTohyee
          ? `The earnings row from ${row.periodStart} runs past ${rowsEnd}: from ${firstTohyee} Tohyee has the employee's own pay runs.`
          : `The earnings row from ${row.periodStart} runs past the opening date (${asAt}).`,
      );
    }
    for (const period of input.approvedPeriods) {
      if (row.periodStart <= period.periodEnd && row.periodEnd >= period.periodStart) {
        throw new ValidationError(`The earnings row from ${row.periodStart} overlaps a pay period Tohyee has approved (${period.periodStart} to ${period.periodEnd}).`);
      }
    }
    const previous = rows[index - 1];
    if (previous) {
      if (row.periodStart <= previous.periodEnd) throw new ValidationError(`The earnings rows from ${previous.periodStart} and ${row.periodStart} overlap.`);
      if (row.periodStart !== addDays(previous.periodEnd, 1)) throw new ValidationError(`There's a gap in the earnings rows from ${addDays(previous.periodEnd, 1)} to ${addDays(row.periodStart, -1)}.`);
    }
    const gross = dec(row.gross);
    const irregular = dec(row.irregular);
    if (isNegative(gross)) throw new ValidationError(`Gross earnings for the row from ${row.periodStart} can't be negative.`);
    if (isNegative(irregular) || cmp(irregular, gross) > 0) throw new ValidationError(`The irregular part of the row from ${row.periodStart} must be from 0 to its gross earnings.`);
    if (!Number.isInteger(row.days) || row.days < 0 || row.days > daysInclusive(row.periodStart, row.periodEnd)) {
      throw new ValidationError(`Days worked or on paid leave for the row from ${row.periodStart} must be a whole number of the period's days (a part day counts as a day, s 9A(2)).`);
    }
  }
  if (rows.at(-1)!.periodEnd !== rowsEnd) {
    throw new ValidationError(`The earnings rows must run to ${rowsEnd} (${firstTohyee ? "the day before Tohyee's first pay period for the employee" : "the opening date"}); the last ends ${rows.at(-1)!.periodEnd}.`);
  }
}

/** The earnings rows as pay periods for the AWE, ADP, four-week and 8% windows. */
export function openingPeriods(rows: readonly OpeningEarningsRow[]): PeriodEarnings[] {
  return rows.map((row) => ({ periodStart: row.periodStart, periodEnd: row.periodEnd, gross: row.gross, irregular: row.irregular }));
}

/**
 * The dates each 4 weeks' annual holidays arose (s 16(1)), with opening
 * balances: the last entitlement before the opening date, then each 12
 * months from it, moved by unpaid leave after the opening date that
 * doesn't count (decision 14). Without a last entitlement (under 12 months
 * at the opening date), from the start date as usual.
 */
export function annualDatesWithOpening(input: {
  startDate: string;
  unpaid: readonly UnpaidLeave[];
  until: string;
  asAt: string;
  lastEntitled: string | null;
}): string[] {
  if (!input.lastEntitled) return annualEntitlementDates(input.startDate, input.unpaid, input.until);
  if (input.lastEntitled > input.until) return [];
  const later = annualEntitlementDates(
    input.lastEntitled,
    input.unpaid.filter((leave) => leave.start > input.asAt),
    input.until,
  );
  return [input.lastEntitled, ...later];
}

/**
 * The days worked or on paid leave in opening rows inside a window (s 9A(2)
 * "b"): each row's days when the whole row is inside; a row only partly
 * inside is refused, as the days in part of it aren't known (HL48).
 */
export function openingDaysBetween(rows: readonly OpeningEarningsRow[], from: string, to: string): number {
  let count = 0;
  for (const row of rows) {
    if (row.periodEnd < from || row.periodStart > to) continue;
    if (row.periodStart < from || row.periodEnd > to) {
      throw refuse(
        `average daily pay over an opening earnings row only partly inside the 52 weeks (${row.periodStart} to ${row.periodEnd}): the days worked in part of it aren't known; enter the rows by pay period`,
      );
    }
    count += row.days;
  }
  return count;
}
