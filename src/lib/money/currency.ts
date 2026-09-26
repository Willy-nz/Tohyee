import { ValidationError } from "@/lib/errors";

/**
 * Currencies Tohyee knows the minor units for (ISO 4217). Posted amounts are
 * rounded to these places at the posting boundary.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  EUR: 2,
  FJD: 2,
  GBP: 2,
  HKD: 2,
  JPY: 0,
  NZD: 2,
  SGD: 2,
  TOP: 2,
  USD: 2,
  WST: 2,
  XPF: 0,
};

export const DEFAULT_BASE_CURRENCY = "NZD";

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNITS, code);
}

export function parseCurrencyCode(input: unknown, fieldName = "currencyCode"): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required.`);
  }
  const code = input.trim().toUpperCase();
  if (!isSupportedCurrency(code)) {
    throw new ValidationError(
      `${fieldName} must be one of ${Object.keys(CURRENCY_MINOR_UNITS).join(", ")}.`,
    );
  }
  return code;
}

export function currencyMinorUnits(code: string): number {
  const units = CURRENCY_MINOR_UNITS[code];
  if (units === undefined) {
    throw new ValidationError(`Unsupported currency ${code}.`);
  }
  return units;
}
