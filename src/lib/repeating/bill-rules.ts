/**
 * What's special about repeating bills (examples RB1-RB3), browser-safe so
 * the editor shows the same numbers and due dates the server makes.
 *
 * - Suppliers have no payment terms in Tohyee, so the due date is a rule like
 *   the ones on Xero's bills: N days after the bill date, N days after the end
 *   of the bill's month, or day N of the following month (the payment terms
 *   maths in `@/lib/customers/terms`).
 * - Every bill needs a supplier invoice number that no other bill from that
 *   supplier has (B5), so a template holds a pattern: {date} becomes the
 *   bill date (2026-01-31), {month} its month (2026-01) and {n} the bill's
 *   number in the template's history (1, 2, 3...). A pattern needs {date} or
 *   {n}, or {month} when it repeats every so many months, so no two dates
 *   give the same number.
 */
import { dueDateFor } from "@/lib/customers/terms";
import type { RepeatPeriod } from "@/lib/repeating/schedule";

export const BILL_DUE_RULES = ["days_after", "days_after_month_end", "day_of_next_month"] as const;
export type BillDueRule = (typeof BILL_DUE_RULES)[number];

export const BILL_DUE_RULE_LABELS: Record<BillDueRule, string> = {
  days_after: "days after the bill date",
  days_after_month_end: "days after the end of the bill month",
  day_of_next_month: "day of the following month",
};

/** The due date of a bill dated `billDate` (RB2). */
export function billDueDate(billDate: string, rule: BillDueRule, days: number): string {
  return dueDateFor(billDate, {
    kind: rule === "days_after" ? "days_after_invoice" : rule,
    days,
  });
}

/** "20 days after the bill date", "20th of the following month". */
export function describeBillDue(rule: BillDueRule, days: number): string {
  if (rule === "day_of_next_month") {
    const tens = days % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][days % 10] ?? "th");
    return `${days}${suffix} of the following month`;
  }
  if (rule === "days_after" && days === 0) return "On the bill date";
  return `${days} ${BILL_DUE_RULE_LABELS[rule]}`;
}

/** The longest a pattern can be, leaving room for the date it's filled with. */
export const NUMBER_PATTERN_MAX = 80;

/** Why a supplier invoice number pattern can't be used, or null (RB3). */
export function numberPatternProblem(pattern: string, period: RepeatPeriod): string | null {
  if (pattern.trim() === "") return "The supplier's invoice number is required.";
  if (pattern.length > NUMBER_PATTERN_MAX) return `The supplier's invoice number can be at most ${NUMBER_PATTERN_MAX} characters.`;
  const unique = pattern.includes("{date}") || pattern.includes("{n}") || (period === "month" && pattern.includes("{month}"));
  if (!unique) {
    return `The supplier's invoice number needs {date} or {n}${period === "month" ? " (or {month})" : ""} in it, so each bill gets its own number (a supplier can't have two bills with the same number).`;
  }
  return null;
}

/** The supplier invoice number for the `n`th bill (from 1), dated `billDate` (RB3). */
export function billNumberFor(pattern: string, billDate: string, n: number): string {
  return pattern.replaceAll("{date}", billDate).replaceAll("{month}", billDate.slice(0, 7)).replaceAll("{n}", String(n)).trim();
}
