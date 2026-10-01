import { add, cmp, dec, type Decimal, divide, isPositive, isZero, mul, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { addDays, addMonths, daysInclusive, eachDay, earlierOf, laterOf } from "./dates";
import { refuse } from "./rules";

/**
 * Gross earnings over a window of time (Holidays Act s 14), and the rates
 * built on them: average weekly earnings (s 5, s 21(2)(b)(ii), s 22),
 * average daily pay (s 9A) and the four-week ordinary weekly pay (s 8(2)).
 * Examples HL3, HL4, HL5, HL7, HL14. Browser-safe and exact: rates are kept
 * unrounded and only payments are rounded, once (decision 26).
 */

/** One pay period's gross earnings, as approved pay runs kept them. */
export type PeriodEarnings = {
  periodStart: string;
  periodEnd: string;
  /** Gross earnings (s 14) in the period, at the amounts paid. */
  gross: string;
  /** The payments s 8(1)(c)(i)-(iii) leaves out: irregular incentives and overtime, one-off payments (s 8(2) "b"). */
  irregular: string;
  /** Hours worked or on paid leave each day, where approved timesheets give them. */
  dayHours?: Readonly<Record<string, string>>;
};

/** How a day is weighted when a pay period is only partly inside a window: its usual hours, or null when they aren't known. */
export type DayWeight = (date: string) => Decimal | null;

export type WindowEarnings = { from: string; to: string; gross: Decimal; irregular: Decimal };

/**
 * The share of a pay period inside a window (HL4): all of it when the whole
 * period is inside, otherwise the hours worked on the days inside over all
 * the period's hours, from the day's timesheet hours or else its usual hours.
 * A period whose share can't be known is refused.
 */
function shareInside(period: PeriodEarnings, from: string, to: string, weight: DayWeight): { numerator: Decimal; denominator: Decimal } {
  if (period.periodStart >= from && period.periodEnd <= to) return { numerator: dec("1"), denominator: dec("1") };
  let inside = ZERO_DECIMAL;
  let all = ZERO_DECIMAL;
  for (const date of eachDay(period.periodStart, period.periodEnd)) {
    const typed = period.dayHours?.[date];
    const hours = typed !== undefined ? dec(typed) : weight(date);
    if (hours === null) {
      throw refuse(
        `average earnings over a pay period only partly inside the 12 months (${period.periodStart} to ${period.periodEnd}) for someone whose hours vary, without approved timesheets for it`,
      );
    }
    all = add(all, hours);
    if (date >= from && date <= to) inside = add(inside, hours);
  }
  if (isZero(all)) return { numerator: ZERO_DECIMAL, denominator: dec("1") };
  return { numerator: inside, denominator: all };
}

/** Gross earnings (and the irregular part) for the days from `from` to `to`, exact. */
export function earningsBetween(periods: readonly PeriodEarnings[], from: string, to: string, weight: DayWeight): WindowEarnings {
  let gross = ZERO_DECIMAL;
  let irregular = ZERO_DECIMAL;
  for (const period of periods) {
    if (period.periodEnd < from || period.periodStart > to) continue;
    const { numerator, denominator } = shareInside(period, from, to, weight);
    if (isZero(numerator)) continue;
    gross = add(gross, divide(mul(dec(period.gross), numerator), denominator, 10));
    irregular = add(irregular, divide(mul(dec(period.irregular), numerator), denominator, 10));
  }
  return { from, to, gross, irregular };
}

/** The 12 calendar months ending on `end` (decision 10): Sun 13 Dec 2026 → Sun 14 Dec 2025 to Sun 13 Dec 2026. */
export function twelveMonthsTo(end: string): { from: string; to: string } {
  return { from: addDays(addMonths(end, -12), 1), to: end };
}

export type AverageWeeklyEarnings = WindowEarnings & { divisor: Decimal; weekly: Decimal };

/**
 * Average weekly earnings (s 5; s 21(2)(b)(ii); HL4, HL5): 1/52 of gross
 * earnings for the 12 calendar months ending at the end of the last pay
 * period before the holiday (decision 10). The divisor is cut only under a
 * recorded agreement to count unpaid leave of more than a week (s 16(3);
 * decision 14). Exact.
 */
export function averageWeeklyEarnings(input: {
  periods: readonly PeriodEarnings[];
  windowEnd: string;
  weight: DayWeight;
  divisorReduction?: string;
}): AverageWeeklyEarnings {
  const { from, to } = twelveMonthsTo(input.windowEnd);
  const earnings = earningsBetween(input.periods, from, to, input.weight);
  const divisor = sub(dec("52"), dec(input.divisorReduction ?? "0"));
  if (!isPositive(divisor)) throw refuse("unpaid leave that takes the whole year out of average weekly earnings");
  return { ...earnings, divisor, weekly: divide(earnings.gross, divisor, 10) };
}

/** Whole or part weeks in a run of days (s 22(3), s 16(3)): 315 days is 45 weeks, 10 days is 2. */
export function wholeOrPartWeeks(days: number): number {
  return Math.ceil(days / 7);
}

/**
 * Average weekly earnings for holidays taken in advance by someone employed
 * for less than 12 months (s 22(2)(b)(ii)(B), s 22(3); HL14): gross
 * earnings since they started, ÷ the whole or part weeks worked.
 */
export function averageWeeklyEarningsSinceStart(input: {
  periods: readonly PeriodEarnings[];
  startDate: string;
  windowEnd: string;
  weight: DayWeight;
}): AverageWeeklyEarnings {
  if (input.windowEnd < input.startDate) {
    return { from: input.startDate, to: input.windowEnd, gross: ZERO_DECIMAL, irregular: ZERO_DECIMAL, divisor: ZERO_DECIMAL, weekly: ZERO_DECIMAL };
  }
  const earnings = earningsBetween(input.periods, input.startDate, input.windowEnd, input.weight);
  const divisor = dec(String(wholeOrPartWeeks(daysInclusive(input.startDate, input.windowEnd))));
  return { ...earnings, divisor, weekly: divide(earnings.gross, divisor, 10) };
}

/**
 * Ordinary weekly pay by the four-week formula (s 8(2); HL3): (a − b) ÷ 4,
 * a being gross earnings for the 4 calendar weeks before the end of the last
 * pay period (or that pay period, when it's longer than 4 weeks) and b the
 * irregular and one-off payments in them. Always worked out and shown, used
 * only when s 8(1) can't give the pay (decision 12).
 */
export function fourWeekOrdinaryPay(input: {
  periods: readonly PeriodEarnings[];
  windowEnd: string;
  /** The start of the last pay period, when the pay period is longer than 4 weeks (monthly pay). */
  longPeriodStart?: string | null;
  weight: DayWeight;
}): WindowEarnings & { weekly: Decimal } {
  const from = input.longPeriodStart ?? addDays(input.windowEnd, -27);
  const earnings = earningsBetween(input.periods, from, input.windowEnd, input.weight);
  const net = sub(earnings.gross, earnings.irregular);
  return { ...earnings, weekly: divide(cmp(net, ZERO_DECIMAL) < 0 ? ZERO_DECIMAL : net, dec("4"), 10) };
}

/**
 * Average daily pay (s 9A(2); HL7): gross earnings for the 52 calendar
 * weeks before the end of the last pay period ÷ the whole or part days
 * worked or on paid holidays or leave in them. Exact; null with no days.
 */
export function averageDailyPay(input: { gross: string | Decimal; days: number }): Decimal | null {
  if (input.days <= 0) return null;
  return divide(typeof input.gross === "string" ? dec(input.gross) : input.gross, dec(String(input.days)), 10);
}

/** The 52 calendar weeks ending on `end` (s 9A(2)). */
export function fiftyTwoWeeksTo(end: string): { from: string; to: string } {
  return { from: addDays(end, -363), to: end };
}

/** A weekly rate × weeks, or a daily rate × days, rounded half up to the cent once (decision 26). */
export function payment(value: Decimal): string {
  return toFixedString(value, 2);
}

/** The greater of two exact rates, with which one won. */
export function greaterOf(owp: Decimal, awe: Decimal): { rate: Decimal; source: "owp" | "awe" } {
  return cmp(awe, owp) > 0 ? { rate: awe, source: "awe" } : { rate: owp, source: "owp" };
}

/** Sum of exact values (re-exported for callers that only import this file). */
export const total = sum;

/** Clamp a window to a period of employment. */
export function clampWindow(window: { from: string; to: string }, start: string, finish: string | null): { from: string; to: string } {
  return { from: laterOf(window.from, start), to: finish ? earlierOf(window.to, finish) : window.to };
}
