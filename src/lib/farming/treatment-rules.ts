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

/**
 * Milk safe from (TRT2): the time of treatment isn't kept, so the hours
 * are counted from the end of the treatment day. Treated 1 Oct with 96
 * hours: from 00:00 on 2 Oct plus 96 hours is 6 Oct. Nil (0) is the day of
 * treatment.
 */
export function milkSafeFrom(treatedOn: string, hours: number | null): string | null {
  if (hours === null) return null;
  if (hours === 0) return treatedOn;
  return addDays(treatedOn, 1 + Math.ceil(hours / 24));
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
  const parts = [now.meat ? `safe for slaughter from ${date(withholding!.meatSafeOn!)}` : null, now.milk ? `milk safe from ${date(withholding!.milkSafeFrom!)}` : null].filter(Boolean);
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
