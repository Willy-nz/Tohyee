/**
 * Payment terms (examples RC1, RC2), browser-safe so the invoice editor fills
 * the due date the same way the server does. Like Xero's and NetSuite's
 * standard and date-driven terms:
 *
 * - `days_after_invoice`: N days after the invoice date ("30 days"; 0 is due
 *   on receipt);
 * - `days_after_month_end`: N days after the last day of the invoice's month;
 * - `day_of_next_month`: day N of the month after the invoice's month (a day
 *   the month doesn't have becomes its last day, so the 31st of February is
 *   the 28th or 29th).
 */
export const PAYMENT_TERM_KINDS = ["days_after_invoice", "days_after_month_end", "day_of_next_month"] as const;
export type PaymentTermKind = (typeof PAYMENT_TERM_KINDS)[number];

export const PAYMENT_TERM_KIND_LABELS: Record<PaymentTermKind, string> = {
  days_after_invoice: "days after the invoice date",
  days_after_month_end: "days after the end of the invoice month",
  day_of_next_month: "day of the following month",
};

export type PaymentTermRule = { kind: PaymentTermKind; days: number };

/** "30 days after the invoice date", "20th of the following month". */
export function describeTerm(term: PaymentTermRule): string {
  if (term.kind === "day_of_next_month") return `${ordinal(term.days)} of the following month`;
  if (term.kind === "days_after_invoice" && term.days === 0) return "Due on the invoice date";
  return `${term.days} ${PAYMENT_TERM_KIND_LABELS[term.kind]}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

function parts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return [year, month, day];
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days in a month (1-12), using the calendar rules for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** The due date for an invoice dated `invoiceDate` (YYYY-MM-DD) on these terms. */
export function dueDateFor(invoiceDate: string, term: PaymentTermRule): string {
  const [year, month] = parts(invoiceDate);
  switch (term.kind) {
    case "days_after_invoice":
      return addDays(invoiceDate, term.days);
    case "days_after_month_end":
      return addDays(iso(year, month, daysInMonth(year, month)), term.days);
    case "day_of_next_month": {
      const nextYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      return iso(nextYear, nextMonth, Math.min(term.days, daysInMonth(nextYear, nextMonth)));
    }
  }
}
