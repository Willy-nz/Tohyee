import { add, cmp, dec, type Decimal, divide, isPositive, isZero, mul, sub, sum, ZERO_DECIMAL } from "@/lib/money/decimal";
import { weekdayIndex } from "./dates";
import { refuse } from "./rules";

/**
 * An employee's usual week (decisions 8, 9, 11; examples HL1, HL2, HL6,
 * HL8): the hours each weekday and the usual extras on it (overtime hours,
 * an allowance per shift), each marked as a regular part of pay or not.
 * The usual week is what the employer and employee agree "genuinely
 * constitutes a working week" (s 17), and gives ordinary weekly pay (s 8(1)),
 * relevant daily pay (s 9) and the hours stored on every leave entry. An
 * employee whose hours and days vary has no fixed week: their working week
 * is agreed in hours (s 17) and ordinary weekly pay comes from the four-week
 * formula (s 8(2); decision 12). Browser-safe.
 */

export type PatternExtra = {
  payItemId: string;
  name: string;
  kind: "overtime" | "allowance";
  /** Overtime hours that day. */
  hours: string | null;
  /** Overtime's rate multiplier (from its pay item). */
  multiplier: string | null;
  /** An allowance's amount for the day (a shift allowance). */
  amount: string | null;
  /** A regular part of the employee's pay, so it counts in ordinary weekly pay (s 8(1)(b); decision 11). */
  regular: boolean;
};

export type PatternDay = { ordinaryHours: string; extras: PatternExtra[] };

export type WorkPattern =
  | { kind: "fixed"; days: PatternDay[] }
  /** Hours and days vary: the agreed working week in hours and days (s 17). */
  | { kind: "varies"; weekHours: string; weekDays: string };

/** The pay rate in effect (P1b pay rate history). */
export type PayRateBasis = { payBasis: "salary" | "hourly"; annualSalary: string | null; hourlyRate: string | null };

function fixedDays(pattern: WorkPattern): PatternDay[] {
  if (pattern.kind !== "fixed") throw new Error("A usual week is needed.");
  return pattern.days;
}

/** A day's usual hours, regular overtime included (Ben's Thursday is 8 + 5 = 13; HL13). */
export function patternDayHours(day: PatternDay): Decimal {
  return add(
    dec(day.ordinaryHours),
    sum(day.extras.filter((extra) => extra.kind === "overtime" && extra.hours !== null).map((extra) => dec(extra.hours!))),
  );
}

/** The usual hours on a date, or 0 when it isn't a usual working day. */
export function usualHoursOn(pattern: WorkPattern, date: string): Decimal {
  return patternDayHours(fixedDays(pattern)[weekdayIndex(date)]);
}

/** Whether a date is one of the employee's usual working days (fixed weeks only). */
export function isUsualWorkingDay(pattern: WorkPattern, date: string): boolean {
  return isPositive(usualHoursOn(pattern, date));
}

/** The usual week in hours (Aroha 40, Fiona 18, Ben 45; HL8, HL13). */
export function weekHours(pattern: WorkPattern): Decimal {
  return pattern.kind === "fixed" ? sum(pattern.days.map(patternDayHours)) : dec(pattern.weekHours);
}

/** The usual week's ordinary hours, without overtime (Ben 40). */
export function weekOrdinaryHours(pattern: WorkPattern): Decimal {
  return sum(fixedDays(pattern).map((day) => dec(day.ordinaryHours)));
}

/** The usual working days in a week (Aroha 5, Fiona 3; HL8). */
export function weekDays(pattern: WorkPattern): Decimal {
  return pattern.kind === "fixed" ? dec(String(pattern.days.filter((day) => isPositive(patternDayHours(day))).length)) : dec(pattern.weekDays);
}

/** A salary's weekly amount, exact: 62,400.00 ÷ 52 = 1,200.00 (HL1). */
export function weeklySalary(rate: PayRateBasis): Decimal {
  return divide(dec(rate.annualSalary!), dec("52"), 10);
}

function hourlyRate(rate: PayRateBasis): Decimal {
  if (rate.payBasis !== "hourly" || rate.hourlyRate === null) throw refuse("overtime in the usual week of someone on a salary");
  return dec(rate.hourlyRate);
}

/** What one usual extra pays: overtime hours × rate × multiplier, or the allowance's amount. */
export function extraValue(extra: PatternExtra, rate: PayRateBasis): Decimal {
  if (extra.kind === "allowance") return dec(extra.amount ?? "0");
  return mul(mul(dec(extra.hours ?? "0"), hourlyRate(rate)), dec(extra.multiplier ?? "1"));
}

/** A usual day's ordinary pay: hours × the hourly rate, or the weekly salary × the day's share of the week's ordinary hours. */
function ordinaryPayForHours(pattern: WorkPattern, rate: PayRateBasis, hours: Decimal): Decimal {
  if (rate.payBasis === "hourly") return mul(hours, dec(rate.hourlyRate!));
  const ordinary = weekOrdinaryHours(pattern);
  if (isZero(ordinary)) throw refuse("a salary with no ordinary hours in the usual week");
  return divide(mul(weeklySalary(rate), hours), ordinary, 10);
}

/**
 * Ordinary weekly pay under s 8(1) (HL1, HL2): pay for an ordinary working
 * week, with the extras that are a regular part of pay (s 8(1)(b)) and
 * without the rest (s 8(1)(c)). Exact.
 */
export function ordinaryWeeklyPay(pattern: WorkPattern, rate: PayRateBasis): Decimal {
  const days = fixedDays(pattern);
  const ordinary = rate.payBasis === "salary" ? weeklySalary(rate) : mul(weekOrdinaryHours(pattern), dec(rate.hourlyRate!));
  const extras = days.flatMap((day) => day.extras.filter((extra) => extra.regular).map((extra) => extraValue(extra, rate)));
  return add(ordinary, sum(extras));
}

/**
 * Relevant daily pay under s 9 (HL6): what the employee would have been paid
 * had they worked that day, with the overtime and allowances they'd have had
 * that day (s 9(1)(b)), never employer KiwiSaver (s 9(1)(c)) or the public
 * holiday's extra half (s 9(3)). Null when the date isn't a usual working
 * day (Ben's Saturday). Exact.
 */
export function relevantDailyPay(pattern: WorkPattern, rate: PayRateBasis, date: string): Decimal | null {
  const day = fixedDays(pattern)[weekdayIndex(date)];
  if (!isPositive(patternDayHours(day))) return null;
  return add(ordinaryPayForHours(pattern, rate, dec(day.ordinaryHours)), sum(day.extras.map((extra) => extraValue(extra, rate))));
}

/**
 * The portion of a day's pay for the time actually worked on a public
 * holiday (s 50(1); HL32). On a usual working day: the ordinary hours, then
 * the day's overtime hours at their multiplier, then any hours beyond the
 * usual day at the ordinary rate (decision 140), plus the day's allowances
 * when any time is worked. On another day (Fiona's Monday) or for someone
 * whose hours vary: the hours × the hourly rate. Exact.
 */
export function payForTimeWorked(pattern: WorkPattern, rate: PayRateBasis, date: string, hoursWorked: string): Decimal {
  const worked = dec(hoursWorked);
  if (!isPositive(worked)) return ZERO_DECIMAL;
  const hourly = rate.payBasis === "hourly" ? dec(rate.hourlyRate!) : null;
  const day = pattern.kind === "fixed" ? pattern.days[weekdayIndex(date)] : null;
  if (!day || !isPositive(patternDayHours(day))) {
    if (hourly) return mul(worked, hourly);
    if (pattern.kind !== "fixed") throw refuse("a public holiday worked by someone on a salary whose hours vary");
    return ordinaryPayForHours(pattern, rate, worked);
  }
  let remaining = worked;
  const take = (limit: Decimal) => {
    const used = cmp(remaining, limit) <= 0 ? remaining : limit;
    remaining = sub(remaining, used);
    return used;
  };
  let pay = ordinaryPayForHours(pattern, rate, take(dec(day.ordinaryHours)));
  for (const extra of day.extras) {
    if (extra.kind === "overtime" && extra.hours !== null) {
      const hours = take(dec(extra.hours));
      pay = add(pay, mul(mul(hours, hourlyRate(rate)), dec(extra.multiplier ?? "1")));
    } else if (extra.kind === "allowance") {
      pay = add(pay, dec(extra.amount ?? "0"));
    }
  }
  if (isPositive(remaining)) pay = add(pay, ordinaryPayForHours(pattern, rate, remaining));
  return pay;
}

/** A usual week with the same hours Monday to Friday and nothing at the weekend (a helper for tests and set-up). */
export function mondayToFriday(hoursPerDay: string, extras: Partial<Record<number, PatternExtra[]>> = {}): WorkPattern {
  return {
    kind: "fixed",
    days: [0, 1, 2, 3, 4, 5, 6].map((index) => ({ ordinaryHours: index < 5 ? hoursPerDay : "0", extras: extras[index] ?? [] })),
  };
}
