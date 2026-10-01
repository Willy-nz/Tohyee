import { add, cmp, dec, type Decimal, isPositive, mul, sub } from "@/lib/money/decimal";
import { addDays, eachDay, WEEKDAY_NAMES, weekdayIndex } from "./dates";
import { type AnniversaryRegion, ANNIVERSARY_REGION_LABELS, coveredYears, publicHolidayYear } from "./public-holiday-dates";
import { refuse } from "./rules";
import { isUsualWorkingDay, usualHoursOn, type WorkPattern } from "./work-pattern";

/**
 * Public holidays for one employee (Holidays Act s 44-s 50, s 56-s 61;
 * examples HL30-HL33; decisions 21-25). Browser-safe and exact.
 */

/** A public holiday as an employee observes it. */
export type ObservedHoliday = {
  /** The date the employee observes it. */
  date: string;
  key: string;
  name: string;
  /** The holiday's own date, before any move off a weekend (s 45, s 45A). */
  actualDate: string;
  /** Moved off a weekend because that day wouldn't otherwise be a working day. */
  moved: boolean;
};

/**
 * Whether a date would otherwise be a working day for the employee: true,
 * false, or null when that isn't clear (hours that vary), for the person
 * running pay to decide (s 12; decision 21).
 */
export type WouldWork = (date: string) => boolean | null;

/** The date a holiday falling on a weekend moves to (s 45(1)(b), (d); s 45A(1)(b)). */
function movedDate(actual: string, transfer: "s45" | "s45A"): string {
  const weekday = weekdayIndex(actual);
  if (transfer === "s45A") return addDays(actual, weekday === 5 ? 2 : 1);
  return addDays(actual, 2);
}

function yearData(year: number) {
  const data = publicHolidayYear(year);
  if (!data) throw refuse(`public holidays in ${year}: Tohyee has the dates for ${coveredYears()} (from Employment NZ); add ${year} when it's published`);
  return data;
}

/**
 * The public holidays an employee observes from `from` to `to` (HL31):
 * national holidays, moved off a weekend when that day wouldn't otherwise be
 * a working day for them (s 45, s 45A: Boxing Day on Sat 26 Dec 2026 is
 * Mon 28 Dec for Aroha but stays Sat 26 Dec for George), and their
 * anniversary day (decision 22). Two holidays on the same day are one
 * (s 44(4)). A weekend holiday whose move can't be decided (null from
 * `wouldWork`) is returned as uncertain, for the person running pay.
 */
export function observedHolidays(input: {
  from: string;
  to: string;
  region: AnniversaryRegion | null;
  wouldWork: WouldWork;
}): { holidays: ObservedHoliday[]; uncertain: ObservedHoliday[] } {
  const holidays = new Map<string, ObservedHoliday>();
  const uncertain: ObservedHoliday[] = [];
  const firstYear = Number(addDays(input.from, -3).slice(0, 4));
  const lastYear = Number(input.to.slice(0, 4));
  for (let year = firstYear; year <= lastYear; year += 1) {
    // A holiday can move up to 2 days, so the days just before `from` matter only for the move.
    const data = year < Number(input.from.slice(0, 4)) ? publicHolidayYear(year) : yearData(year);
    if (!data) continue;
    const entries = [
      ...data.national,
      ...(input.region
        ? [{ key: "anniversary_day", name: `${ANNIVERSARY_REGION_LABELS[input.region]} Anniversary Day`, date: data.anniversary[input.region], transfer: null }]
        : []),
    ];
    for (const holiday of entries) {
      let date = holiday.date;
      let moved = false;
      const weekend = weekdayIndex(holiday.date) >= 5;
      if (holiday.transfer && weekend) {
        const works = input.wouldWork(holiday.date);
        if (works === null) {
          const entry = { date: holiday.date, key: holiday.key, name: holiday.name, actualDate: holiday.date, moved: false };
          if (holiday.date >= input.from && holiday.date <= input.to) uncertain.push(entry);
          const later = movedDate(holiday.date, holiday.transfer);
          if (later >= input.from && later <= input.to) uncertain.push({ ...entry, date: later, moved: true });
          continue;
        }
        if (!works) {
          date = movedDate(holiday.date, holiday.transfer);
          moved = true;
        }
      }
      if (date < input.from || date > input.to) continue;
      const existing = holidays.get(date);
      if (existing) {
        existing.name = `${existing.name} and ${holiday.name}`;
        continue;
      }
      holidays.set(date, { date, key: holiday.key, name: holiday.name, actualDate: holiday.date, moved });
    }
  }
  return { holidays: [...holidays.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), uncertain };
}

/** A usual week's answer to "would this otherwise be a working day?" (s 12(3)(a), (b)): known for a fixed week, not for hours that vary. */
export function wouldWorkFromPattern(pattern: WorkPattern): WouldWork {
  return (date) => (pattern.kind === "fixed" ? isUsualWorkingDay(pattern, date) : null);
}

/**
 * Tohyee's suggestion for whether a day would otherwise be a working day
 * for someone whose hours vary (decision 21; HL30), from the same weekday
 * in the 4 weeks before: a working day when they worked at least 2 of the
 * 4 (decision 146). The person running pay confirms or changes it, and the
 * decision is recorded.
 */
export function suggestOtherwiseWorkingDay(date: string, hoursByDate: Readonly<Record<string, string>>): { suggested: boolean; basis: string } {
  const weekday = WEEKDAY_NAMES[weekdayIndex(date)];
  const earlier = [7, 14, 21, 28].map((days) => addDays(date, -days));
  const worked = earlier.filter((day) => isPositive(dec(hoursByDate[day] ?? "0"))).length;
  return { suggested: worked >= 2, basis: `worked ${worked} of the last 4 ${weekday}s` };
}

/**
 * Pay for working on a public holiday (s 50; HL32; decision 23): the
 * greater of (a) the pay for the time worked, less any penal rate, plus
 * half again, and (b) the pay for the time worked with the penal rate.
 * Rounded once by the caller.
 */
export function publicHolidayWorkedPay(input: { payForTime: Decimal; hoursWorked: string; penalHourlyRate?: string | null }): {
  amount: Decimal;
  timeAndAHalf: Decimal;
  withPenal: Decimal;
} {
  const timeAndAHalf = mul(input.payForTime, dec("1.5"));
  const withPenal = input.penalHourlyRate ? add(input.payForTime, mul(dec(input.hoursWorked), dec(input.penalHourlyRate))) : input.payForTime;
  return { amount: cmp(withPenal, timeAndAHalf) > 0 ? withPenal : timeAndAHalf, timeAndAHalf, withPenal };
}

/**
 * The public holidays annual holidays not yet taken would have covered had
 * they been taken straight after the last day (s 40(3); HL16; decisions
 * 17, 18): walking the usual working days from the day after, holidays on
 * them don't use the leave's hours. Ben's 90 hours from Mon 21 Dec 2026 run
 * to Thu 7 Jan 2027 and cover 4 holidays. Needs a usual week.
 */
export function holidaysInUntakenLeave(input: {
  finishDate: string;
  hours: Decimal;
  pattern: WorkPattern;
  region: AnniversaryRegion | null;
}): { holidays: ObservedHoliday[]; lastDay: string | null } {
  if (input.pattern.kind !== "fixed") {
    throw refuse("the public holidays in untaken annual holidays (s 40(3)) for someone whose hours vary: it needs a usual week");
  }
  const pattern = input.pattern;
  let remaining = input.hours;
  let lastDay: string | null = null;
  const found: ObservedHoliday[] = [];
  let chunkStart = addDays(input.finishDate, 1);
  const horizon = addDays(input.finishDate, 3 * 366);
  // Walk a month at a time, so only the years the leave reaches need holiday dates.
  while (isPositive(remaining)) {
    if (chunkStart > horizon) throw refuse("untaken annual holidays longer than 3 years");
    const chunkEnd = addDays(chunkStart, 30);
    const { holidays } = observedHolidays({ from: chunkStart, to: chunkEnd, region: input.region, wouldWork: wouldWorkFromPattern(pattern) });
    const byDate = new Map(holidays.map((holiday) => [holiday.date, holiday]));
    for (const date of eachDay(chunkStart, chunkEnd)) {
      if (!isPositive(remaining)) break;
      if (!isUsualWorkingDay(pattern, date)) continue;
      const holiday = byDate.get(date);
      if (holiday) {
        found.push(holiday);
        continue;
      }
      remaining = sub(remaining, usualHoursOn(pattern, date));
      lastDay = date;
    }
    chunkStart = addDays(chunkEnd, 1);
  }
  return { holidays: found, lastDay };
}
