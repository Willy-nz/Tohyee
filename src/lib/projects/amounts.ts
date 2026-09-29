import { ValidationError } from "@/lib/errors";
import { add, dec, divide, isZero, mul, mulDiv, roundHalfUp, sub, toFixedString, toPlainString } from "@/lib/money/decimal";

/**
 * Project maths (examples PJ3-PJ9), browser-safe so the project screens show
 * the same figures as the server. Durations are whole minutes; money is
 * worked out exactly and rounded to the cent once, half away from zero.
 */

export const CHARGE_TYPES = ["hourly", "fixed", "non_chargeable"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

export const CHARGE_TYPE_LABELS: Record<ChargeType, string> = {
  hourly: "Hourly rate",
  fixed: "Fixed price",
  non_chargeable: "Non-chargeable",
};

/** The most one time entry can be: a whole day. */
export const MAX_ENTRY_MINUTES = 24 * 60;

const SIXTY = dec("60");
const HUNDRED = dec("100");

/** "2 h 30 min", "45 min", "4 h", "0 min". */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${sign}${rest} min`;
  return rest === 0 ? `${sign}${hours} h` : `${sign}${hours} h ${rest} min`;
}

/** Hours to 2 decimal places, for columns (225 minutes -> "3.75"). */
export function minutesAsHours(minutes: number): string {
  return toFixedString(divide(dec(String(minutes)), SIXTY, 2), 2);
}

/**
 * A duration entered as hours and minutes (either may be blank), as whole
 * minutes: 2 h 30 min is 150 (PJ3). Refuses anything but whole numbers, and
 * a total outside 1 minute to `max` minutes.
 */
export function durationMinutes(hoursInput: unknown, minutesInput: unknown, what = "The time", max = MAX_ENTRY_MINUTES): number {
  const part = (input: unknown, label: string): number => {
    if (input == null || (typeof input === "string" && input.trim() === "")) return 0;
    const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : null;
    if (text === null || !/^\d{1,5}$/.test(text)) {
      throw new ValidationError(`${what}'s ${label} must be a whole number.`);
    }
    return Number.parseInt(text, 10);
  };
  const total = part(hoursInput, "hours") * 60 + part(minutesInput, "minutes");
  if (total < 1) throw new ValidationError(`${what} must be at least 1 minute.`);
  if (total > max) throw new ValidationError(`${what} can be at most ${formatMinutes(max)}.`);
  return total;
}

/** minutes x rate per hour / 60, rounded to the cent: time's charge (PJ5) and its cost (PJ3). */
export function timeAmount(minutes: number, ratePerHour: string): string {
  return toFixedString(mulDiv(dec(String(minutes)), dec(ratePerHour), SIXTY, 2), 2);
}

/**
 * The hours of `minutes` when they're exact to 4 decimal places (the
 * quantity an invoice line can hold), else null: 225 -> "3.75", 12 -> "0.2",
 * 10 -> null (PJ7).
 */
export function exactHours(minutes: number): string | null {
  const hours = divide(dec(String(minutes)), SIXTY, 4);
  const back = mul(hours, SIXTY);
  return isZero(sub(back, dec(String(minutes)))) ? toPlainString(roundHalfUp(hours, 4)) : null;
}

/** An expense's charge: cost x (100 + markup %) / 100, rounded to the cent (PJ4). */
export function chargeWithMarkup(cost: string, markupPercent: string): string {
  return toFixedString(mulDiv(dec(cost), add(HUNDRED, dec(markupPercent)), HUNDRED, 2), 2);
}

/** The invoice line for a task's time: hours x rate when exact, else 1 x the amount (PJ6, PJ7). */
export function timeInvoiceLine(taskName: string, minutes: number, ratePerHour: string): { description: string; quantity: string; unitPrice: string; amount: string } {
  const amount = timeAmount(minutes, ratePerHour);
  const hours = exactHours(minutes);
  const description = `${taskName} (${formatMinutes(minutes)})`;
  return hours === null
    ? { description, quantity: "1", unitPrice: amount, amount }
    : { description, quantity: hours, unitPrice: toPlainString(dec(ratePerHour)), amount };
}
