import { addDays, financialYearStart } from "@/lib/financial-year";

/*
 * The demo farm's shape, worked out from today's date (#437, decisions
 * 855-869): pure functions, so they're tested on their own. Every figure is
 * made up; they're only meant to look like a ~300-cow Otago dairy farm.
 */

/** The balance date: 31 May, as most dairy farms. */
export const DEMO_YEAR_END_MONTH = 5;

/** A small, fast, seeded random number source (mulberry32): the same seed gives the same farm. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed for a day, so a farm made on the same day is the same farm. */
export function seedFor(today: string): number {
  return Number(today.replace(/-/g, "")) % 2147483647;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function monthKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

/**
 * The first day of the books: 1 June at or before twelve months ago, so
 * there are always one whole season and the season so far (12 to 23 months;
 * about 18 on average).
 */
export function demoStart(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  const back = `${year - 1}-${pad(month)}-${pad(Math.min(day, 28))}`;
  return financialYearStart(back, DEMO_YEAR_END_MONTH);
}

/** Every month from the start to today's month, as YYYY-MM. */
export function demoMonths(start: string, today: string): string[] {
  const months: string[] = [];
  let [year, month] = start.split("-").map(Number);
  const last = today.slice(0, 7);
  for (;;) {
    const keyed = monthKey(year, month);
    if (keyed > last) break;
    months.push(keyed);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** A day of a month (YYYY-MM), kept within the month. */
export function dayOf(month: string, day: number): string {
  const end = lastDayOf(month);
  const last = Number(end.slice(8, 10));
  return `${month}-${pad(Math.min(Math.max(day, 1), last))}`;
}

export function lastDayOf(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

export function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return number === 12 ? monthKey(year + 1, 1) : monthKey(year, number + 1);
}

/** The season (financial year) a date is in, by its 31 May end. */
export function seasonEnd(date: string): string {
  const start = financialYearStart(date, DEMO_YEAR_END_MONTH);
  return addDays(`${Number(start.slice(0, 4)) + 1}-06-01`, -1);
}

/**
 * kg of milk solids supplied in a month by about 300 cows: none in June and
 * July (dry), a peak in October and November, about 370 kg MS a cow a season.
 */
const MILK_SOLIDS_BY_MONTH: Record<number, number> = { 6: 0, 7: 0, 8: 7200, 9: 13000, 10: 16500, 11: 16000, 12: 14500, 1: 12500, 2: 10500, 3: 9500, 4: 7500, 5: 3300 };

export function milkSolidsFor(month: string, random: () => number): number {
  const base = MILK_SOLIDS_BY_MONTH[Number(month.slice(5, 7))];
  if (!base) return 0;
  // Within 5% either way, to the whole kg.
  return Math.round(base * (0.95 + random() * 0.1));
}

/** The co-op's advance price for a season, $/kg MS excluding GST, as text. */
export function milkPriceFor(seasonEndDate: string): string {
  const year = Number(seasonEndDate.slice(0, 4));
  // Made up: a little higher each season.
  return ["9.35", "9.70", "10.05", "9.85", "10.20"][year % 5];
}

/** Average pasture cover (kg DM/ha) for a month on the milking platform. */
const COVER_BY_MONTH: Record<number, number> = { 6: 2050, 7: 1950, 8: 2000, 9: 2250, 10: 2500, 11: 2650, 12: 2550, 1: 2350, 2: 2250, 3: 2300, 4: 2400, 5: 2200 };

export function averageCoverFor(month: string): number {
  return COVER_BY_MONTH[Number(month.slice(5, 7))];
}

/** The milking season: cows are milked August to May. */
export function inMilk(month: string): boolean {
  return MILK_SOLIDS_BY_MONTH[Number(month.slice(5, 7))] > 0;
}

/** Cents between min and max dollars, as a money string (no floating-point money). */
export function moneyBetween(random: () => number, min: number, max: number): string {
  const cents = Math.round(min * 100) + Math.floor(random() * (Math.round(max * 100) - Math.round(min * 100) + 1));
  return `${Math.floor(cents / 100)}.${pad(cents % 100)}`;
}

/** Two-monthly GST periods ending in odd months (May, July, ...), as [start, end]; only whole periods ended before today. */
export function gstPeriods(start: string, today: string): Array<[string, string]> {
  const periods: Array<[string, string]> = [];
  for (const month of demoMonths(start, today)) {
    if (Number(month.slice(5, 7)) % 2 === 0) {
      const end = lastDayOf(nextMonth(month));
      if (end < today) periods.push([`${month}-01`, end]);
    }
  }
  return periods;
}

/** When a two-monthly GST return is due: the 28th of the next month, 15 January for November, 7 May for March. */
export function gstDueDate(periodEnd: string): string {
  const month = Number(periodEnd.slice(5, 7));
  const year = Number(periodEnd.slice(0, 4));
  if (month === 11) return `${year + 1}-01-15`;
  if (month === 3) return `${year}-05-07`;
  return `${nextMonth(periodEnd.slice(0, 7))}-28`;
}
