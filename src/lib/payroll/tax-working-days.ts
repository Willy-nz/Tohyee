import { publicHolidayYear } from "@/lib/payroll/leave/public-holiday-dates";

/**
 * A "working day" for tax (decision 326): the Income Tax Act 2007's s YA 1
 * definition, which the Tax Administration Act 1994 uses (s 3(2); text in
 * docs/sources/working-day-tax.md). Not a working day: Saturday, Sunday,
 * Waitangi Day, Good Friday, Easter Monday, Anzac Day, the Sovereign's
 * birthday, Matariki and Labour Day; the Monday after Waitangi Day or Anzac
 * Day when it falls on a weekend; and 25 December to 15 January. Regional
 * anniversary days, Christmas and New Year's transfers (Holidays Act s 45)
 * aren't in the list, so they're working days here.
 *
 * Good Friday, Easter Monday, the Sovereign's birthday, Matariki and Labour
 * Day come from the public holiday dates Tohyee holds (P8: 2025-2027). For a
 * year it doesn't hold they're treated as working days, so a due date
 * worked out with them is never later than IRD's.
 */

const MOVABLE = new Set(["good_friday", "easter_monday", "sovereigns_birthday", "matariki", "labour_day"]);

function isoWeekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addOneDay(date: string, days = 1): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Monday after a fixed holiday that falls on a weekend (s YA 1 (ab)). */
function mondayAfterWeekend(fixed: string): string | null {
  const weekday = isoWeekdayOf(fixed);
  if (weekday === 6) return addOneDay(fixed, 2);
  if (weekday === 7) return addOneDay(fixed, 1);
  return null;
}

export function isTaxWorkingDay(date: string): boolean {
  const weekday = isoWeekdayOf(date);
  if (weekday >= 6) return false;
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  // (b) 25 December to 15 January.
  if (monthDay >= "12-25" || monthDay <= "01-15") return false;
  // (a) and (ab) Waitangi Day and Anzac Day, and the Monday after when they fall on a weekend.
  for (const fixed of [`${year}-02-06`, `${year}-04-25`]) {
    if (date === fixed || date === mondayAfterWeekend(fixed)) return false;
  }
  // (a) the movable ones, from the dates Tohyee holds.
  const held = publicHolidayYear(year);
  if (held && held.national.some((holiday) => MOVABLE.has(holiday.key) && holiday.date === date)) return false;
  return true;
}

/** The date `count` working days after `date` (decision 326). */
export function taxWorkingDaysAfter(date: string, count: number): string {
  let current = date;
  let counted = 0;
  while (counted < count) {
    current = addOneDay(current);
    if (isTaxWorkingDay(current)) counted += 1;
  }
  return current;
}
