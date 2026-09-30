/**
 * What's special about repeating bills (examples RB1-RB3), browser-safe so
 * the editor shows the same numbers and due dates the server makes.
 *
 * - The due date is the supplier's payment terms (RB12, SPT3), or a rule
 *   like the ones on Xero's bills: N days after the bill date, N days after
 *   the end of the bill's month, or day N of the following month (the payment
 *   terms maths in `@/lib/customers/terms`).
 * - An approved bill needs a supplier invoice number that no other bill from
 *   that supplier has (B5), so a template can hold a pattern: {date} becomes
 *   the bill date (2026-01-31), {month} its month (2026-01) and {n} the bill's
 *   number in the template's history (1, 2, 3...). A pattern needs {date} or
 *   {n}, or {month} when it repeats every so many months, so no two dates
 *   give the same number. Or the pattern is left empty (RB11, like NetSuite's
 *   optional reference number): each bill is then a draft without a number,
 *   completed when the supplier's real invoice arrives.
 */
import { dueDateFor } from "@/lib/customers/terms";
import type { RepeatPeriod } from "@/lib/repeating/schedule";

export const BILL_DUE_RULES = ["terms", "days_after", "days_after_month_end", "day_of_next_month"] as const;
export type BillDueRule = (typeof BILL_DUE_RULES)[number];
/** The rules worked out from a number of days, without the supplier's terms. */
export type BillDaysRule = Exclude<BillDueRule, "terms">;

export const BILL_DUE_RULE_LABELS: Record<BillDueRule, string> = {
  terms: "the supplier's payment terms",
  days_after: "days after the bill date",
  days_after_month_end: "days after the end of the bill month",
  day_of_next_month: "day of the following month",
};

/** The due date of a bill dated `billDate` by a rule of days (RB2). */
export function billDueDate(billDate: string, rule: BillDaysRule, days: number): string {
  return dueDateFor(billDate, {
    kind: rule === "days_after" ? "days_after_invoice" : rule,
    days,
  });
}

/** "20 days after the bill date", "20th of the following month". */
export function describeBillDue(rule: BillDueRule, days: number): string {
  if (rule === "terms") return "By the supplier's payment terms";
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

/**
 * Why a supplier invoice number pattern can't be used, or null (RB3). An
 * empty pattern is fine when bills are saved as drafts (RB11); approving
 * needs a number.
 */
export function numberPatternProblem(pattern: string, period: RepeatPeriod, saveAs: "draft" | "approve" = "draft"): string | null {
  if (pattern.trim() === "") {
    return saveAs === "approve"
      ? "Bills without a supplier's invoice number are saved as drafts, so give a number pattern to approve them automatically, or save them as drafts."
      : null;
  }
  if (pattern.length > NUMBER_PATTERN_MAX) return `The supplier's invoice number can be at most ${NUMBER_PATTERN_MAX} characters.`;
  const unique = pattern.includes("{date}") || pattern.includes("{n}") || (period === "month" && pattern.includes("{month}"));
  if (!unique) {
    return `The supplier's invoice number needs {date} or {n}${period === "month" ? " (or {month})" : ""} in it, so each bill gets its own number (a supplier can't have two bills with the same number).`;
  }
  return null;
}

/** The supplier invoice number for the `n`th bill (from 1), dated `billDate` (RB3); null without a pattern (RB11). */
export function billNumberFor(pattern: string | null, billDate: string, n: number): string | null {
  if (pattern === null || pattern.trim() === "") return null;
  return pattern.replaceAll("{date}", billDate).replaceAll("{month}", billDate.slice(0, 7)).replaceAll("{n}", String(n)).trim();
}
