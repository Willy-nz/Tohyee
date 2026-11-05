import { ValidationError } from "@/lib/errors";
import { add, cmp, dec, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/*
 * Rainfall's rules (decisions 1451-1456; examples RF1-RF8, not yet
 * reviewed). Pure and browser-safe, so the Log, the Rainfall page and the
 * server agree. Tested in tests/unit/rainfall-rules.test.ts.
 *
 * - A reading is the rain in one gauge for one day, in millimetres to one
 *   place (0 to 2,000). No rain is 0, typed: a day with no reading is
 *   unknown, never counted as dry.
 * - The day is the rain day: a gauge read at 9 am is the rain to 9 am, and
 *   is recorded for the day before, as official 9 am records are (Jess,
 *   5 Nov 2026). Read on 5 November, it's 4 November's rain. A rain day
 *   is over once the next morning's reading is due, so today can't be one.
 * - Totals add the readings in a period. Each says how many of its days
 *   have a reading, so a gap shows.
 * - "Same time last year" is the same days a year earlier. A period still
 *   going (this month, this season) is compared to the same part of last
 *   year's: 1-5 November 2026 with 1-5 November 2025. 29 February becomes
 *   28 February.
 * - Seasons are New Zealand's: spring September to November, summer
 *   December to February, autumn March to May, winter June to August.
 */

export const MAX_MM = "2000";

/** The millimetres typed, as a one-place string ("12.5", "0.0"), or a clear error. */
export function parseMm(input: unknown, label = "Rain"): string {
  const text = typeof input === "string" ? input.trim().replace(/\s*mm$/i, "") : input;
  const value = parseDecimalInput(text, `${label} (mm)`, { maxScale: 1, allowZero: true });
  if (cmp(dec(value), dec(MAX_MM)) > 0) throw new ValidationError(`${label} must be from 0 to 2,000 mm.`);
  return toFixedString(dec(value), 1);
}

/** For a form: the millimetres, or null when it isn't a number Tohyee takes. */
export function tryMm(input: string): string | null {
  try {
    return parseMm(input);
  } catch {
    return null;
  }
}

export function mmText(mm: string | null): string {
  if (mm === null) return "No readings";
  const [whole, part] = mm.split(".");
  return `${Number(whole).toLocaleString("en-NZ")}${part && part !== "0" ? `.${part}` : ""} mm`;
}

export type DayReading = { readOn: string; mm: string };

/** The rain day a gauge read on `readDay` (the morning) is recorded for: the day before. */
export function rainDayFor(readDay: string): string {
  return new Date(Date.parse(`${readDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The morning a rain day is read: the day after. */
export function readDayFor(rainDay: string): string {
  return new Date(Date.parse(`${rainDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The latest rain day there can be a reading for: yesterday (read this morning). */
export function latestRainDay(today: string): string {
  return rainDayFor(today);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** The same day a year earlier (29 February becomes 28 February). */
export function yearEarlier(date: string): string {
  const [y, m, d] = parts(date);
  return iso(y - 1, m, Math.min(d, daysInMonth(y - 1, m)));
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export type Span = { from: string; to: string; mm: string | null; days: number; daysRead: number };

export type Period = {
  key: string;
  label: string;
  /** Still going: it runs to `today`, and last year's is the same part of it. */
  toDate: boolean;
  current: Span;
  lastYear: Span;
};

/** Adds the readings from `from` to `to`; null mm when there are none. */
export function spanTotal(readings: DayReading[], from: string, to: string): Span {
  let total = ZERO_DECIMAL;
  let read = 0;
  for (const reading of readings) {
    if (reading.readOn < from || reading.readOn > to) continue;
    total = add(total, dec(reading.mm));
    read += 1;
  }
  return { from, to, mm: read ? toFixedString(total, 1) : null, days: daysBetween(from, to), daysRead: read };
}

function period(readings: DayReading[], key: string, label: string, from: string, end: string, today: string): Period {
  const toDate = today >= from && today < end;
  const to = toDate ? today : end;
  return { key, label, toDate, current: spanTotal(readings, from, to), lastYear: spanTotal(readings, yearEarlier(from), yearEarlier(to)) };
}

/** Each month from `count - 1` months before today's to today's, oldest first, with the same months last year. */
export function monthTotals(readings: DayReading[], today: string, count = 12): Period[] {
  const [y, m] = parts(today);
  const out: Period[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = y * 12 + (m - 1) - back;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const from = iso(year, month, 1);
    const end = iso(year, month, daysInMonth(year, month));
    out.push(period(readings, `${year}-${pad(month)}`, `${MONTHS[month - 1]} ${year}`, from, end, today));
  }
  return out;
}

export const SEASONS = ["summer", "autumn", "winter", "spring"] as const;
export type Season = (typeof SEASONS)[number];
const SEASON_NAMES: Record<Season, string> = { summer: "Summer", autumn: "Autumn", winter: "Winter", spring: "Spring" };

/** The season a date is in: its name, first and last day. Summer is named for both its years ("Summer 2026-27"). */
export function seasonOf(date: string): { key: string; label: string; from: string; to: string; season: Season } {
  const [y, m] = parts(date);
  // Summer starting in December belongs to that year; January and February are the previous year's summer.
  const startYear = m <= 2 ? y - 1 : y;
  const season: Season = m === 12 || m <= 2 ? "summer" : m <= 5 ? "autumn" : m <= 8 ? "winter" : "spring";
  const startMonth = { summer: 12, autumn: 3, winter: 6, spring: 9 }[season];
  const from = iso(startYear, startMonth, 1);
  const endYear = season === "summer" ? startYear + 1 : startYear;
  const endMonth = season === "summer" ? 2 : startMonth + 2;
  const to = iso(endYear, endMonth, daysInMonth(endYear, endMonth));
  const label = season === "summer" ? `Summer ${startYear}-${String(startYear + 1).slice(2)}` : `${SEASON_NAMES[season]} ${startYear}`;
  return { key: `${startYear}-${season}`, label, from, to, season };
}

/** The last `count` seasons to today's, oldest first, each with the same season last year. */
export function seasonTotals(readings: DayReading[], today: string, count = 4): Period[] {
  const seasons: Array<ReturnType<typeof seasonOf>> = [];
  let cursor = today;
  for (let index = 0; index < count; index += 1) {
    const season = seasonOf(cursor);
    seasons.unshift(season);
    const [y, m] = parts(season.from);
    cursor = m === 1 ? iso(y - 1, 12, 1) : iso(y, m - 1, 1);
  }
  return seasons.map((season) => period(readings, season.key, season.label, season.from, season.to, today));
}

export type RainTotals = { thisMonth: Period; thisSeason: Period; last12Months: Period };

/** The headline totals: this month and this season so far, and the 12 months to today, each with last year's. */
export function rainTotals(readings: DayReading[], today: string): RainTotals {
  const [y, m] = parts(today);
  const month = period(readings, "month", "This month", iso(y, m, 1), iso(y, m, daysInMonth(y, m)), today);
  const season = seasonOf(today);
  // The 12 months to today: from the day after the same day last year.
  const start = yearEarlier(today);
  const next = nextDay(start);
  return {
    thisMonth: month,
    thisSeason: period(readings, "season", `${season.label} so far`, season.from, season.to, today),
    last12Months: { key: "12", label: "Last 12 months", toDate: false, current: spanTotal(readings, next, today), lastYear: spanTotal(readings, yearEarlier(next), start) },
  };
}

/** The earliest date a summary needs, for reading only what's used: two years and a season before today. */
export function summaryFrom(today: string): string {
  const [y, m] = parts(today);
  return iso(y - 3, m, 1);
}

/** How a period compares with last year, in words ("12.5 mm more than last year"), or null when either has no readings. */
export function comparedText(entry: Pick<Period, "current" | "lastYear">): string | null {
  if (entry.current.mm === null || entry.lastYear.mm === null) return null;
  const difference = cmp(dec(entry.current.mm), dec(entry.lastYear.mm));
  if (difference === 0) return "Same as last year";
  const more = difference > 0;
  const gap = more ? sub(dec(entry.current.mm), dec(entry.lastYear.mm)) : sub(dec(entry.lastYear.mm), dec(entry.current.mm));
  return `${mmText(toFixedString(gap, 1))} ${more ? "more" : "less"} than last year`;
}
