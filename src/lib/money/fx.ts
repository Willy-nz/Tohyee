import { dec, mul, mulDiv, roundHalfUp, toFixedString, toPlainString } from "@/lib/money/decimal";

/**
 * Foreign-currency conversion (D2, examples FXB1-FXB11). Browser-safe, so the
 * screens show the same base amounts the server posts.
 */

/** Foreign amount x rate, with the full rate, rounded once to the base currency's units, half away from zero. */
export function convertAtRate(foreignAmount: string, rate: string, baseScale = 2): string {
  return toFixedString(roundHalfUp(mul(dec(foreignAmount), dec(rate)), baseScale), baseScale);
}

/** The rate implied by a base amount and a foreign amount (base / foreign), to 8 decimal places. */
export function impliedRate(baseAmount: string, foreignAmount: string): string {
  return toPlainString(mulDiv(dec(baseAmount), dec("1"), dec(foreignAmount), 8));
}

/** A rate as typed: a plain positive number with at most 8 decimal places. */
export function isRateText(value: string): boolean {
  const match = /^\d+(?:\.(\d{1,8}))?$/.exec(value.trim());
  return match !== null && /[1-9]/.test(value);
}
