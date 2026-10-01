import { add, cmp, dec, type Decimal, divide, isNegative, isPositive, mul, sub, sum, toFixedString } from "@/lib/money/decimal";
import { addDays, addMonths, daysBetween, daysInclusive, earlierOf, laterOf } from "./dates";
import { wholeOrPartWeeks } from "./earnings";
import { addLeave, compareLeave, type LeaveQuantity, leaveHours, leaveUnits, NO_LEAVE, signOfLeave, unitsOf } from "./quantity";
import { refuse } from "./rules";

/**
 * Annual holidays under the Holidays Act 2003 (examples HL10-HL16): when
 * each 4 weeks arises (s 16), what a holiday is paid (s 21, s 22), holidays
 * in advance (s 20; decisions 15, 16), cashing up (s 28A-s 28F; decision 29)
 * and holiday pay when employment ends (s 23-s 26, s 40(3); decisions 17,
 * 18). Pure and exact; each payment is rounded once (decision 26).
 * Browser-safe.
 */

export const ANNUAL_WEEKS = "4";
export const EIGHT_PERCENT = "0.08";

/** A period of unpaid leave and whether it counts towards the 12 months (s 16(2)). */
export type UnpaidLeave = {
  start: string;
  end: string;
  /** Unpaid sick, bereavement or family violence leave, parental, volunteers or ACC leave: always counts (s 16(2)(a)). */
  statutory: boolean;
  /** A written agreement to count leave of more than a week (s 16(2)(b), s 16(3)). */
  agreedToCount: boolean;
};

/** Whether unpaid leave counts towards the 12 months: statutory leave, a single period of a week or less, or agreed (s 16(2); decision 14). */
export function unpaidLeaveCounts(leave: UnpaidLeave): boolean {
  return leave.statutory || daysInclusive(leave.start, leave.end) <= 7 || leave.agreedToCount;
}

/**
 * The dates each 4 weeks' annual holidays arise, up to `until` (s 16(1);
 * HL10). After each completed 12 months: started Tue 1 Apr 2025, entitled
 * Wed 1 Apr 2026. Unpaid leave that doesn't count moves every later
 * anniversary by its whole length (decision 14): 3 weeks' unpaid leave in
 * Feb 2026 makes it Wed 22 Apr 2026.
 */
export function annualEntitlementDates(startDate: string, unpaid: readonly UnpaidLeave[], until: string): string[] {
  const moving = unpaid.filter((leave) => !unpaidLeaveCounts(leave)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const dates: string[] = [];
  for (let year = 1; year < 200; year += 1) {
    let shift = 0;
    let candidate = addMonths(startDate, 12 * year);
    for (;;) {
      const counted = moving.filter((leave) => leave.start < candidate).reduce((days, leave) => days + daysInclusive(leave.start, leave.end), 0);
      if (counted === shift) break;
      shift = counted;
      candidate = addDays(addMonths(startDate, 12 * year), shift);
    }
    if (candidate > until) break;
    dates.push(candidate);
  }
  return dates;
}

/**
 * How far an agreement to count unpaid leave cuts the AWE divisor (s 16(3);
 * decision 14): the whole or part weeks over one week of each agreed period
 * inside the 12 months. Aroha's 3 weeks cut 52 to 50.
 */
export function divisorReduction(unpaid: readonly UnpaidLeave[], window: { from: string; to: string }): number {
  let reduction = 0;
  for (const leave of unpaid) {
    if (leave.statutory || !leave.agreedToCount || daysInclusive(leave.start, leave.end) <= 7) continue;
    const inside = daysInclusive(laterOf(leave.start, window.from), earlierOf(leave.end, window.to));
    if (inside > 0) reduction += Math.max(0, wholeOrPartWeeks(inside) - 1);
  }
  return reduction;
}

/** 4 weeks of annual holidays in hours of the usual week at the time (HL8: Aroha 160 hours, Fiona 72). */
export function annualEntitlement(weekHours: string): LeaveQuantity {
  return leaveUnits(ANNUAL_WEEKS, weekHours);
}

/**
 * Pay for annual holidays (s 21(2), s 22(2); HL11, HL13): the weekly rate
 * (the greater of ordinary weekly pay and average weekly earnings) × the
 * weeks, the weeks being the leave's hours ÷ the usual week's hours
 * (decision 9). Rounded once. Ben's Thursday: 77,080.00 × 13 ÷ (52 × 45)
 * = 428.22 and 0.2889 week.
 */
export function annualHolidayPay(input: { hours: string | Decimal; weekHours: string | Decimal; weeklyRate: Decimal }): {
  quantity: LeaveQuantity;
  weeks: Decimal;
  amount: string;
} {
  const hours = typeof input.hours === "string" ? dec(input.hours) : input.hours;
  const week = typeof input.weekHours === "string" ? dec(input.weekHours) : input.weekHours;
  return {
    quantity: leaveHours(hours, week),
    weeks: divide(hours, week, 8),
    amount: toFixedString(divide(mul(input.weeklyRate, hours), week, 6), 2),
  };
}

/**
 * What's been earned since the last anniversary (or the start) towards the
 * next 4 weeks, for the advance warning (decision 15; HL14): days ÷ 365 × 4.
 * Eru, 6 Apr 2026 to 15 Feb 2027: 315 ÷ 365 × 4 = 3.45 weeks.
 */
export function earnedTowardsNext(since: string, on: string): Decimal {
  const days = Math.max(0, daysBetween(since, on));
  return divide(mul(dec(String(days)), dec(ANNUAL_WEEKS)), dec("365"), 8);
}

/** Whether someone has worked for the employer for 12 months by a date (s 22(2)(b)(ii)(A)). */
export function employedTwelveMonths(startDate: string, on: string): boolean {
  return addMonths(startDate, 12) <= on;
}

/** The entitlement year a date falls in (s 28A(5)): from the last anniversary to the day before the next. */
export function entitlementYear(entitlementDates: readonly string[], on: string): { from: string; to: string } | null {
  const last = [...entitlementDates].reverse().find((date) => date <= on);
  if (!last) return null;
  const index = entitlementDates.indexOf(last);
  const next = entitlementDates[index + 1] ?? addMonths(last, 12);
  return { from: last, to: addDays(next, -1) };
}

/**
 * Checks a cash-up (s 28A, s 28B; decision 29; HL12): at most 1 week in an
 * entitlement year, only out of holidays already entitled to (not in
 * advance), and only when the organisation doesn't have a policy against
 * them (s 28E).
 */
export function checkCashUp(input: {
  weeks: string;
  cashedUpThisYear: string;
  entitledBalance: LeaveQuantity;
  weekHours: string;
  noCashUpPolicy: boolean;
  hasEntitlement: boolean;
}): void {
  if (input.noCashUpPolicy) throw refuse("a cash-up: the organisation has a policy not to consider them (s 28E)");
  if (!input.hasEntitlement) throw refuse("cashing up annual holidays before any entitlement has arisen (holidays in advance aren't an entitlement, s 28A(1))");
  const weeks = dec(input.weeks);
  if (!isPositive(weeks)) throw refuse("a cash-up of 0 weeks");
  if (cmp(add(dec(input.cashedUpThisYear), weeks), dec("1")) > 0) {
    throw refuse(
      `more than 1 week cashed up in an entitlement year (s 28A(2)(b)): ${toFixedString(dec(input.cashedUpThisYear), 4)} weeks already this year`,
    );
  }
  if (compareLeave(leaveUnits(input.weeks, input.weekHours), input.entitledBalance) > 0) {
    throw refuse("cashing up more than the annual holidays already entitled to (holidays in advance can't be cashed up, s 28A(1))");
  }
}

/** One part of holiday pay when employment ends (HL15, HL16). */
export type TerminationPart = {
  kind: "untaken_entitlement" | "public_holidays" | "eight_percent" | "alternative_holidays";
  description: string;
  amount: string;
  /** Leave paid out, in hours of its unit (weeks for annual holidays, days for alternative holidays). */
  quantity: LeaveQuantity;
  basis: Record<string, string | string[] | number | boolean | null>;
};

export type TerminationInput = {
  /** Whether an annual holidays entitlement has arisen (s 23 vs s 24-s 25). */
  entitled: boolean;
  /** Untaken annual holidays the employee is entitled to, at the finish (s 24). */
  untaken: LeaveQuantity;
  weekHours: string;
  owp: Decimal;
  awe: Decimal;
  /** Public holidays in the untaken time (s 40(3)): each date and the pay for it. */
  publicHolidays: ReadonlyArray<{ date: string; name: string; pay: Decimal }>;
  /** Gross earnings since the start (s 23) or the last entitlement (s 25), this final pay's included. */
  grossSince: Decimal;
  grossSinceDate: string;
  /** Holiday pay for annual holidays taken in advance, not yet covered by an entitlement (s 23(2)(a), s 25(2)(a)). */
  advancePaid: Decimal;
  /** Untaken alternative holidays and the pay for each at the last day's rate (s 60(2)(b)). */
  alternativeHolidays: ReadonlyArray<{ arose: string; pay: Decimal; hours: string }>;
};

export type TerminationResult = {
  parts: TerminationPart[];
  total: string;
  /** Advance holiday pay more than the 8%: deducted only with written consent (decision 16). */
  advanceExcess: string | null;
};

/**
 * Holiday pay when employment ends (s 23-s 26, s 40(3), s 60(2)(b); HL15,
 * HL16; decisions 17, 18). Before any entitlement: 8% of gross earnings
 * since the start, less advance holiday pay (s 23). After: the untaken
 * entitlement at the greater of OWP and AWE (s 24), the public holidays
 * the untaken time would have covered (s 40(3)), and 8% of gross earnings
 * since the last entitlement with both of those added (s 25, s 26; decision
 * 17), less advance holiday pay. Each part rounded once, and a part
 * already rounded counts in the 8% at the amount paid.
 */
export function terminationHolidayPay(input: TerminationInput): TerminationResult {
  const parts: TerminationPart[] = [];
  let gross = input.grossSince;
  if (input.entitled && signOfLeave(input.untaken) > 0) {
    const weekly = cmp(input.awe, input.owp) > 0 ? input.awe : input.owp;
    const weeks = unitsOf(input.untaken, 8);
    const amount = toFixedString(mul(weekly, unitsOf(input.untaken, 12)), 2);
    parts.push({
      kind: "untaken_entitlement",
      description: `Untaken annual holidays, ${trim(weeks)} weeks at $${toFixedString(weekly, 2)} a week (s 24)`,
      amount,
      quantity: input.untaken,
      basis: {
        section: "s 24",
        weeks: trim(weeks),
        ordinaryWeeklyPay: toFixedString(input.owp, 6),
        averageWeeklyEarnings: toFixedString(input.awe, 6),
        rateUsed: cmp(input.awe, input.owp) > 0 ? "awe" : "owp",
      },
    });
    gross = add(gross, dec(amount));
  }
  if (input.entitled && input.publicHolidays.length > 0) {
    const amount = toFixedString(sum(input.publicHolidays.map((holiday) => holiday.pay)), 2);
    parts.push({
      kind: "public_holidays",
      description: `Public holidays in the untaken annual holidays: ${input.publicHolidays.map((holiday) => holiday.name).join(", ")} (s 40(3))`,
      amount,
      quantity: NO_LEAVE,
      basis: {
        section: "s 40(3)",
        dates: input.publicHolidays.map((holiday) => holiday.date),
        pays: input.publicHolidays.map((holiday) => toFixedString(holiday.pay, 6)),
      },
    });
    gross = add(gross, dec(amount));
  }
  const eight = mul(gross, dec(EIGHT_PERCENT));
  const net = sub(eight, input.advancePaid);
  let advanceExcess: string | null = null;
  if (isNegative(net)) {
    advanceExcess = toFixedString(sub(input.advancePaid, eight), 2);
  } else if (isPositive(net)) {
    parts.push({
      kind: "eight_percent",
      description: `8% of gross earnings since ${input.grossSinceDate}${isPositive(input.advancePaid) ? `, less $${toFixedString(input.advancePaid, 2)} paid in advance` : ""} (${input.entitled ? "s 25" : "s 23"})`,
      amount: toFixedString(net, 2),
      quantity: NO_LEAVE,
      basis: {
        section: input.entitled ? "s 25" : "s 23",
        grossEarnings: toFixedString(gross, 6),
        since: input.grossSinceDate,
        eightPercent: toFixedString(eight, 6),
        advancePaid: toFixedString(input.advancePaid, 2),
      },
    });
  }
  for (const holiday of input.alternativeHolidays) {
    parts.push({
      kind: "alternative_holidays",
      description: `Alternative holiday that arose on ${holiday.arose}, untaken (s 60(2)(b))`,
      amount: toFixedString(holiday.pay, 2),
      quantity: leaveHours(holiday.hours, holiday.hours === "0" ? "1" : holiday.hours),
      basis: { section: "s 60(2)(b)", arose: holiday.arose, pay: toFixedString(holiday.pay, 6) },
    });
  }
  const total = toFixedString(sum(parts.map((part) => dec(part.amount))), 2);
  return { parts, total, advanceExcess };
}

function trim(value: Decimal): string {
  const text = toFixedString(value, 8).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}`;
}

/** Sum of leave quantities (re-exported for services). */
export function totalLeave(quantities: readonly LeaveQuantity[]): LeaveQuantity {
  return addLeave(...quantities);
}

