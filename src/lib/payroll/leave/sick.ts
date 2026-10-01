import { add, cmp, dec, type Decimal, divide, isNegative, isPositive, mul, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { addDays, addMonths, daysInclusive, eachDay } from "./dates";
import { addLeave, compareLeave, type LeaveQuantity, leaveHours, leaveUnits, minLeave, NO_LEAVE, signOfLeave, subtractLeave } from "./quantity";

/**
 * Sick, bereavement and family violence leave under the Holidays Act 2003
 * (s 63-s 72J; examples HL20-HL27; decisions 19, 20, 27). Day-based
 * balances: a whole day is 1 unit; a part day (only where a part-day
 * agreement is recorded, decision 19) is its hours ÷ the day's usual hours.
 * Browser-safe and exact.
 */

export const SICK_DAYS_A_YEAR = "10";
export const SICK_CARRY_OVER_LIMIT = "10";
export const SICK_MAXIMUM = "20";
export const FAMILY_VIOLENCE_DAYS_A_YEAR = "10";

/** A day as a unit of day-based leave. */
export const DAY = "1";

export function days(count: string): LeaveQuantity {
  return leaveUnits(count, DAY);
}

/** Bereavement kinds (s 69(2), s 70(1)): 3 days for close family, a miscarriage or still-birth; 1 day for anyone else the employer accepts. */
export const BEREAVEMENT_KINDS = ["close_family", "pregnancy_loss", "other"] as const;
export type BereavementKind = (typeof BEREAVEMENT_KINDS)[number];
export const BEREAVEMENT_DAYS: Record<BereavementKind, number> = { close_family: 3, pregnancy_loss: 3, other: 1 };
export const BEREAVEMENT_LABELS: Record<BereavementKind, string> = {
  close_family: "Close family (3 days, s 69(2)(a))",
  pregnancy_loss: "Miscarriage or still-birth (3 days, s 69(2)(c), (d))",
  other: "Someone else, accepted by the employer (1 day, s 69(2)(b))",
};

/**
 * When sick, bereavement and family violence leave arise for someone with 6
 * months' current continuous employment (s 63(1)(a), s 63(2)(a), s 72D;
 * HL20): at the end of the 6 months, then every 12 months. Aroha, started
 * Tue 1 Apr 2025: Wed 1 Oct 2025, Thu 1 Oct 2026, …
 */
export function sickEntitlementDates(startDate: string, until: string): string[] {
  const dates: string[] = [];
  for (let months = 6; months < 2400; months += 12) {
    const date = addMonths(startDate, months);
    if (date > until) break;
    dates.push(date);
  }
  return dates;
}

/**
 * The hours test for someone without 6 months' continuous employment
 * (s 63(1)(b), s 72D(1)(b); HL21): over the 6 months from `from`, an
 * average of at least 10 hours a week, and at least 1 hour in every week
 * (7-day blocks from `from`) or at least 40 hours in every calendar month
 * (decision 20; a calendar month only partly inside needs its share of 40,
 * decision 145).
 */
export function hoursTestMet(dailyHours: Readonly<Record<string, string>>, from: string): { met: boolean; reason: string } {
  const to = addDays(addMonths(from, 6), -1);
  const dates = eachDay(from, to);
  const hoursOn = (date: string) => dec(dailyHours[date] ?? "0");
  const total = dates.reduce((sum, date) => add(sum, hoursOn(date)), ZERO_DECIMAL);
  const weeks = divide(dec(String(dates.length)), dec("7"), 8);
  const average = divide(total, weeks, 8);
  if (cmp(average, dec("10")) < 0) return { met: false, reason: `averaged ${toFixedString(average, 2)} hours a week (at least 10 needed)` };
  let everyWeek = true;
  for (let index = 0; index < dates.length; index += 7) {
    const block = dates.slice(index, index + 7);
    if (!block.some((date) => isPositive(hoursOn(date)))) everyWeek = false;
  }
  if (everyWeek) return { met: true, reason: "at least 10 hours a week on average and some work every week" };
  const months = new Map<string, string[]>();
  for (const date of dates) months.set(date.slice(0, 7), [...(months.get(date.slice(0, 7)) ?? []), date]);
  for (const [month, inside] of months) {
    const monthDays = daysInclusive(`${month}-01`, addDays(addMonths(`${month}-01`, 1), -1));
    const needed = divide(mul(dec("40"), dec(String(inside.length))), dec(String(monthDays)), 8);
    const worked = inside.reduce((sum, date) => add(sum, hoursOn(date)), ZERO_DECIMAL);
    if (cmp(worked, needed) < 0) return { met: false, reason: `a week with no work, and fewer than 40 hours in ${month}` };
  }
  return { met: true, reason: "at least 10 hours a week on average and at least 40 hours in every calendar month" };
}

export type DayLeaveTaken = { date: string; quantity: LeaveQuantity };

export type DayLeaveEvent =
  | { date: string; kind: "entitled"; quantity: LeaveQuantity; carried: LeaveQuantity; lapsed: LeaveQuantity; balance: LeaveQuantity }
  | { date: string; kind: "taken"; quantity: LeaveQuantity; balance: LeaveQuantity };

/**
 * A sick leave balance over time (s 65, s 66; HL22): 10 days each
 * anniversary, plus what's carried over from the year before, up to 10
 * days, to at most 20; the rest lapses. Sick leave taken in advance (a
 * negative balance, s 63(3)) comes off the next 10.
 */
export function sickLeaveBalance(entitlementDates: readonly string[], taken: readonly DayLeaveTaken[], on: string): {
  balance: LeaveQuantity;
  events: DayLeaveEvent[];
} {
  return dayLeaveBalance(entitlementDates, taken, on, (before) => {
    if (signOfLeave(before) <= 0) return { carried: before, lapsed: NO_LEAVE };
    const carried = minLeave(before, days(SICK_CARRY_OVER_LIMIT));
    return { carried, lapsed: subtractLeave(before, carried) };
  }, days(SICK_DAYS_A_YEAR));
}

/**
 * A family violence leave balance (s 72H; HL27): 10 days each anniversary,
 * not carried over; leave taken in advance (s 72D(3)) comes off the next 10.
 */
export function familyViolenceLeaveBalance(entitlementDates: readonly string[], taken: readonly DayLeaveTaken[], on: string): {
  balance: LeaveQuantity;
  events: DayLeaveEvent[];
} {
  return dayLeaveBalance(entitlementDates, taken, on, (before) =>
    signOfLeave(before) <= 0 ? { carried: before, lapsed: NO_LEAVE } : { carried: NO_LEAVE, lapsed: before },
  days(FAMILY_VIOLENCE_DAYS_A_YEAR));
}

function dayLeaveBalance(
  entitlementDates: readonly string[],
  taken: readonly DayLeaveTaken[],
  on: string,
  carry: (before: LeaveQuantity) => { carried: LeaveQuantity; lapsed: LeaveQuantity },
  yearly: LeaveQuantity,
): { balance: LeaveQuantity; events: DayLeaveEvent[] } {
  type Step = { date: string; order: number; apply: () => void };
  let balance: LeaveQuantity = NO_LEAVE;
  const events: DayLeaveEvent[] = [];
  const steps: Step[] = [
    ...entitlementDates
      .filter((date) => date <= on)
      .map((date) => ({
        date,
        order: 0,
        apply: () => {
          const { carried, lapsed } = carry(balance);
          balance = addLeave(carried, yearly);
          events.push({ date, kind: "entitled", quantity: yearly, carried, lapsed, balance });
        },
      })),
    ...taken
      .filter((entry) => entry.date <= on)
      .map((entry) => ({
        date: entry.date,
        order: 1,
        apply: () => {
          balance = subtractLeave(balance, entry.quantity);
          events.push({ date: entry.date, kind: "taken", quantity: entry.quantity, balance });
        },
      })),
  ].sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
  for (const step of steps) step.apply();
  return { balance, events };
}

/**
 * How much of a day's sick (or family violence) leave comes off the
 * balance (decision 19; HL23): a whole day, unless a part-day agreement is
 * recorded for the employee, when it's the hours off ÷ the day's usual hours
 * (4 of 8 = 0.5 day).
 */
export function dayLeaveTaken(input: { hoursOff: string; dayHours: string; partDayAgreed: boolean }): LeaveQuantity {
  const off = dec(input.hoursOff);
  const day = dec(input.dayHours);
  if (!input.partDayAgreed || cmp(off, day) >= 0) return days("1");
  return leaveHours(off, day);
}

/** Whether a quantity is more than a balance allows (leave in advance). */
export function exceeds(quantity: LeaveQuantity, balance: LeaveQuantity): boolean {
  return compareLeave(quantity, balance) > 0;
}

export function isOverdrawn(balance: LeaveQuantity): boolean {
  return signOfLeave(balance) < 0;
}

/** Amount of a day's pay for sick leave when part of the day was worked (HL23): the day's pay less the pay for the time worked. */
export function partDaySickPay(dailyPay: Decimal, paidForWork: Decimal): Decimal {
  const rest = add(dailyPay, mul(paidForWork, dec("-1")));
  return isNegative(rest) ? ZERO_DECIMAL : rest;
}
