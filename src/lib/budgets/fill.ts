import { add, dec, type Decimal, mul, mulDiv, toFixedString } from "@/lib/money/decimal";

/**
 * Budget months and quick fill (examples BU2-BU4). Browser-safe: the budget
 * screen uses the same maths to show what a quick fill will do, and the
 * server uses it again when saving.
 */

/** Months are "YYYY-MM" in the API and screens, stored as the month's first day. */
export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const BUDGET_LIMITS = {
  nameLength: 100,
  /** Months shown and filled at once. */
  months: 24,
  /** Amounts changed in one save. */
  amountsPerSave: 5000,
  /** A quick fill's % change, either way. */
  percent: 1000,
} as const;

export type QuickFillMethod = "same" | "actuals";

export const QUICK_FILL_METHODS: Record<QuickFillMethod, string> = {
  same: "The same amount each month",
  actuals: "Last year's actuals",
};

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthFromIndex(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The month `count` months after (or before, when negative) `month`. */
export function addMonths(month: string, count: number): string {
  return monthFromIndex(monthIndex(month) + count);
}

/** `count` months from `first`, in order. */
export function monthRange(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addMonths(first, index));
}

/** The first day of a "YYYY-MM" month. */
export function monthStartDate(month: string): string {
  return `${month}-01`;
}

/** The last day of a "YYYY-MM" month. */
export function monthEndDate(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, "0")}`;
}

/** Whole months from `from` to `to` inclusive (0 when `to` is before `from`). */
export function monthsBetween(from: string, to: string): number {
  return Math.max(0, monthIndex(to) - monthIndex(from) + 1);
}

const HUNDRED = dec("100");

/**
 * An amount changed by a percentage, rounded once to `scale` places, halves
 * away from zero (BU4: 1,200.00 + 10% = 1,320.00; 500.00 - 5% = 475.00).
 */
export function adjustByPercent(amount: string, percent: string | null, scale: number): string {
  if (percent === null) return toFixedString(dec(amount), scale);
  return toFixedString(mulDiv(dec(amount), add(HUNDRED, dec(percent)), HUNDRED, scale), scale);
}

/**
 * The same amount each month, optionally changing by a percentage each month
 * (BU3, like Xero's "adjust by % each month"): month n is the amount x
 * (1 + percent / 100)^n worked out exactly, then rounded once to `scale`
 * places, so rounding never compounds.
 */
export function fillSameAmount(amount: string, months: number, percent: string | null, scale: number): string[] {
  const start = dec(amount);
  const factor = add(HUNDRED, dec(percent ?? "0"));
  const results: string[] = [];
  let top: Decimal = start;
  let bottom: Decimal = dec("1");
  for (let index = 0; index < months; index += 1) {
    results.push(toFixedString(mulDiv(top, dec("1"), bottom, scale), scale));
    top = mul(top, factor);
    bottom = mul(bottom, HUNDRED);
  }
  return results;
}
