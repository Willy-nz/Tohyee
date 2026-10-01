import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";

/**
 * IRD's payment periods for employment deductions and their due dates
 * (examples PPAY4, PPAY9). Pure: no database, no network.
 *
 * IRD, "Paying deductions to Inland Revenue"
 * (https://www.ird.govt.nz/employing-staff/payday-filing/paying-deductions-to-inland-revenue,
 * last updated 23 Mar 2026, read 1 Oct 2026):
 * - gross annual PAYE and ESCT less than $500,000: "pay deductions monthly,
 *   by the 20th of the following month";
 * - more than $500,000: twice a month. Wages paid 1st-15th "By the 20th of
 *   the same month"; wages paid 16th-end of month "By the 5th of the
 *   following month. Note: For period 16-31 December pay by 15 January not
 *   5 January".
 * IRD, "When to pay" (https://www.ird.govt.nz/managing-my-tax/make-a-payment/when-to-pay,
 * last updated 1 Apr 2026): "For due dates that fall on a weekend or public
 * holiday, we need to receive your payment on or before the next working
 * day." Only weekends are moved here: Tohyee has no list of public holidays
 * yet, so the screens say so.
 */

export type IrdPaymentFrequency = "monthly" | "twice_monthly";

export const IRD_PAYMENT_FREQUENCIES: readonly IrdPaymentFrequency[] = ["monthly", "twice_monthly"];

export type IrdPeriod = {
  frequency: IrdPaymentFrequency;
  /** First and last pay date in the period (IRD counts wages by when they're paid). */
  start: string;
  end: string;
  /** IRD's due date. */
  dueDate: string;
  dueWeekday: string;
  /** The due date, or the Monday after when it falls on a weekend. */
  payBy: string;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function iso(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekday(date: string): number {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  return iso(year, month, day + days);
}

function dueDateFor(frequency: IrdPaymentFrequency, start: string): string {
  const { year, month, day } = parts(start);
  if (frequency === "monthly" || day === 16) {
    if (frequency === "twice_monthly" && month === 12) return iso(year + 1, 1, 15);
    return iso(year, month + 1, frequency === "monthly" ? 20 : 5);
  }
  return iso(year, month, 20);
}

function period(frequency: IrdPaymentFrequency, start: string): IrdPeriod {
  const { year, month, day } = parts(start);
  const end = frequency === "twice_monthly" && day === 1 ? iso(year, month, 15) : iso(year, month, lastDayOfMonth(year, month));
  const dueDate = dueDateFor(frequency, start);
  const dueDay = weekday(dueDate);
  const payBy = dueDay === 6 ? addDays(dueDate, 2) : dueDay === 0 ? addDays(dueDate, 1) : dueDate;
  return { frequency, start, end, dueDate, dueWeekday: WEEKDAYS[dueDay], payBy };
}

export function parseIrdPaymentFrequency(input: unknown): IrdPaymentFrequency {
  if (input === "monthly" || input === "twice_monthly") return input;
  throw new ValidationError('How often you pay IRD must be "monthly" or "twice_monthly".');
}

/** The IRD period a pay date falls in. */
export function irdPeriodContaining(payDate: string, frequency: IrdPaymentFrequency): IrdPeriod {
  const { year, month, day } = parts(parseIsoDate(payDate, "Pay date"));
  return period(frequency, iso(year, month, frequency === "twice_monthly" && day >= 16 ? 16 : 1));
}

/** The IRD period starting on `start`, which must be the start of one of IRD's periods (PPAY6). */
export function irdPeriodFromStart(startInput: unknown, frequency: IrdPaymentFrequency): IrdPeriod {
  const start = parseIsoDate(startInput, "Period start");
  const { day } = parts(start);
  if (frequency === "monthly" && day !== 1) {
    throw new ValidationError("For monthly IRD payments the period starts on the 1st of a month.");
  }
  if (frequency === "twice_monthly" && day !== 1 && day !== 16) {
    throw new ValidationError("For IRD payments twice a month the period starts on the 1st or the 16th of a month.");
  }
  return period(frequency, start);
}

/** The distinct IRD periods the given pay dates fall in, oldest first. */
export function irdPeriodsBetween(payDates: readonly string[], frequency: IrdPaymentFrequency): IrdPeriod[] {
  const byStart = new Map<string, IrdPeriod>();
  for (const date of payDates) {
    const found = irdPeriodContaining(date, frequency);
    byStart.set(found.start, found);
  }
  return [...byStart.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
