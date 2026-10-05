/**
 * Mileage on expense claims (MI1-MI7): the vehicle types IRD publishes
 * kilometre rates for, and income years. Browser-safe.
 */

export const VEHICLE_TYPES = ["petrol", "diesel", "petrol_hybrid", "electric"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  petrol: "Petrol",
  diesel: "Diesel",
  petrol_hybrid: "Petrol hybrid",
  electric: "Electric",
};

/** Tier 1 is for the first 14,000 km of a claimant's mileage per vehicle type in an income year (question 3). */
export const TIER1_KM = "14000";
/** Kilometres on one line: more than 0, at most 2,000, one decimal place (MI7). */
export const MAX_LINE_KM = "2000";

/** The income year (1 April - 31 March) a date is in, named by the year it ends: 2026-10-03 is in 2027 ("2026-27"). */
export function incomeYearEnding(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return month >= 4 ? year + 1 : year;
}

/** "2025-26" for the year ending 31 March 2026. */
export function incomeYearLabel(yearEnding: number): string {
  return `${yearEnding - 1}-${String(yearEnding).slice(-2)}`;
}

/** The first and last days of an income year. */
export function incomeYearDates(yearEnding: number): { from: string; to: string } {
  return { from: `${yearEnding - 1}-04-01`, to: `${yearEnding}-03-31` };
}

/** A rate with at least two decimal places, as IRD writes them: "1.2" is "1.20". */
export function formatKmRate(rate: string): string {
  const [whole, fraction = ""] = rate.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
