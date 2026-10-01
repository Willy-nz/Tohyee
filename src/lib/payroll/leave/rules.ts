import { ValidationError } from "@/lib/errors";

/**
 * Which leave law applies (decision 7). Tohyee builds the Holidays Act 2003
 * as one dated rule-set that ends at each employee's first pay period
 * starting on or after 6 Aug 2028, when the Employment Leave Act 2026 takes
 * over (its sch 1 cl 6) and can't be followed early. Anything from then on
 * is refused until the new Act is built (after MBIE's technical guidance).
 * Browser-safe.
 */

export const NOT_SUPPORTED = "Not supported yet (refused rather than guessed)";

/** The Employment Leave Act 2026 commences (s 2(1)). */
export const EMPLOYMENT_LEAVE_ACT_STARTS = "2028-08-06";

export const LEAVE_TYPES = ["annual", "sick", "bereavement", "family_violence", "alternative"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  annual: "Annual holidays",
  sick: "Sick leave",
  bereavement: "Bereavement leave",
  family_violence: "Family violence leave",
  alternative: "Alternative holiday",
};

/** Whether the Holidays Act 2003 applies to a pay period that starts on this date (decision 7). */
export function holidaysActApplies(periodStart: string): boolean {
  return periodStart < EMPLOYMENT_LEAVE_ACT_STARTS;
}

/** Refuses a pay period (or a date standing for one) under the Employment Leave Act 2026. */
export function assertHolidaysAct(periodStart: string, what = "leave"): void {
  if (!holidaysActApplies(periodStart)) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: ${what} in a pay period starting on or after 6 Aug 2028, under the Employment Leave Act 2026. Tohyee follows the Holidays Act 2003 until then.`,
    );
  }
}

export function refuse(what: string): ValidationError {
  return new ValidationError(`${NOT_SUPPORTED}: ${what}.`);
}
