import { addDays } from "@/lib/farming/farm-words";
import { cmp, dec, divide, toPlainString } from "@/lib/money/decimal";

/*
 * Treatments, withholding and product stock rules (decisions 1431-1438;
 * examples TRT1-TRT8, common NZ practice, not yet reviewed). Browser-safe.
 *
 * Withholding periods come from the product's label. Tohyee keeps what the
 * person enters and never supplies one.
 */

export const LABEL_NOTE = "Withholding periods come from the product label. Tohyee keeps what you enter and never fills one in.";

/**
 * Safe for slaughter from (TRT1): the day of treatment plus the meat
 * withholding days. Treated 1 Oct with 14 days: 15 Oct.
 */
export function meatSafeOn(treatedOn: string, days: number | null): string | null {
  return days === null ? null : addDays(treatedOn, days);
}

export const TREATMENT_TIME_ZONE = "Pacific/Auckland";

/** "7:30" or "07:30" as "07:30"; null when blank; undefined when it isn't a time. */
export function parseTimeGiven(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined || text.trim() === "") return null;
  const match = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(text.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** The farm's local wall time on a date as an instant, in a time zone (daylight saving included). */
function localInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-NZ", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - at;
  };
  let instant = guess - offset(guess);
  instant = guess - offset(instant);
  return instant;
}

/** An instant as the farm's local "YYYY-MM-DDTHH:MM". */
function localText(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export type MilkBasis = "time_given" | "end_of_day";

/**
 * Milk safe from (TRT2; Jess, 5 Nov 2026). With the time given (the farm's
 * local time), it's that time plus the label's hours, exactly: given 7:30
 * am on 1 Oct with 96 hours is 7:30 am on 5 Oct ("2026-10-05T07:30"),
 * across a daylight saving change too. With no time given, the hours count
 * from the end of the treatment day: 96 hours from 1 Oct is 6 Oct (a date).
 * Nil (0) is the time given, or the day of treatment.
 */
export function milkSafeFrom(treatedOn: string, hours: number | null, givenTime: string | null = null, timeZone = TREATMENT_TIME_ZONE): string | null {
  if (hours === null) return null;
  if (givenTime) return localText(localInstant(treatedOn, givenTime, timeZone) + hours * 3_600_000, timeZone);
  if (hours === 0) return treatedOn;
  return addDays(treatedOn, 1 + Math.ceil(hours / 24));
}

export function milkBasis(givenTime: string | null): MilkBasis {
  return givenTime ? "time_given" : "end_of_day";
}

/** "7:30 am" from "07:30". */
export function timeText(time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "am" : "pm"}`;
}

/** How the milk date was counted, for the screens: "from 7:30 am" or "from end of day, no time given". */
export function milkBasisText(givenTime: string | null): string {
  return givenTime ? `from ${timeText(givenTime)}` : "from end of day, no time given";
}

/** A safe date or date-time in words: "6 Oct" or "5 Oct 7:30 am" (`date` formats the day). */
export function safeText(value: string, date: (iso: string) => string = (iso) => iso): string {
  const [day, time] = value.split("T");
  return time ? `${date(day)} ${timeText(time)}` : date(day);
}

/** The later of two dates (either may be null). */
export function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export type Withholding = { meatSafeOn: string | null; milkSafeFrom: string | null };

/** Whether stock is still withheld on `today`: a safe date after today. */
export function withheld(withholding: Withholding | null, today: string): { meat: boolean; milk: boolean } {
  return { meat: Boolean(withholding?.meatSafeOn && withholding.meatSafeOn > today), milk: Boolean(withholding?.milkSafeFrom && withholding.milkSafeFrom > today) };
}

/** Words for a mob's withholding on `today`, or null when none is in force. */
export function withholdingText(withholding: Withholding | null, today: string, date: (iso: string) => string = (iso) => iso): string | null {
  const now = withheld(withholding, today);
  const parts = [now.meat ? `safe for slaughter from ${date(withholding!.meatSafeOn!)}` : null, now.milk ? `milk safe from ${safeText(withholding!.milkSafeFrom!, date)}` : null].filter(Boolean);
  return parts.length ? `Withholding: ${parts.join("; ")}` : null;
}

/** Units product stock is kept in. mL and g are turned into L and kg to add up (TRT7). */
export const STOCK_UNITS = ["L", "mL", "kg", "g", "doses", "each"] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

/** Each unit's base, and how many of it make one base unit (tractor jobs also use t). */
const BASE: Readonly<Record<string, { base: string; per: string }>> = {
  L: { base: "L", per: "1" },
  mL: { base: "L", per: "1000" },
  kg: { base: "kg", per: "1" },
  g: { base: "kg", per: "1000" },
  t: { base: "kg", per: "0.001" },
  doses: { base: "doses", per: "1" },
  each: { base: "each", per: "1" },
};

/** A quantity in its unit's base (L, kg, doses, each); null for a unit Tohyee doesn't know. */
export function toBase(quantity: string, unit: string): { quantity: string; unit: string } | null {
  const entry = BASE[unit];
  if (!entry) return null;
  return { quantity: toPlainString(divide(dec(quantity), dec(entry.per), 3)), unit: entry.base };
}

export function isPositiveQuantity(text: string): boolean {
  return /^\d+(\.\d{1,3})?$/.test(text) && cmp(dec(text), dec("0")) > 0;
}
