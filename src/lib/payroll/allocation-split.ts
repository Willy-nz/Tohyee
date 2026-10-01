import { ValidationError } from "@/lib/errors";
import {
  abs,
  add,
  cmp,
  dec,
  type Decimal,
  divide,
  isNegative,
  isPositive,
  mul,
  neg,
  parseDecimalInput,
  significantScale,
  sub,
  sum,
  toFixedString,
  truncate,
} from "@/lib/money/decimal";

/**
 * Splitting an amount across an employee's cost allocation lines (examples
 * PE3-PE5). Browser-safe: no server imports.
 */

const ONE_HUNDRED = dec("100");
const CENT = dec("0.01");

/** A line's percentage: more than 0, at most 100, at most 2 decimal places (PE5). */
export function parseAllocationPercentage(input: unknown, label: string): string {
  const value = parseDecimalInput(input, `${label} percentage`, { maxScale: 2 });
  if (cmp(dec(value), ONE_HUNDRED) > 0) throw new ValidationError(`${label} percentage can't be more than 100%.`);
  return value;
}

/** Lines must total exactly 100.00% (PE5). */
export function assertTotalsOneHundred(percentages: readonly string[]): void {
  if (percentages.length === 0) throw new ValidationError("An allocation needs at least one line.");
  const total = sum(percentages.map(dec));
  if (cmp(total, ONE_HUNDRED) !== 0) {
    throw new ValidationError(`The allocation lines total ${toFixedString(total, 2)}%. They must total exactly 100.00%.`);
  }
}

/**
 * Splits `amount` (at most 2 decimal places) by `percentages` (totalling
 * 100.00%) into parts that add back to exactly the amount (PE3, PE4).
 *
 * Each exact share is cut to whole cents towards zero; the cents left over go
 * one each to the lines with the largest part cut off, the earlier line first
 * when two tie. A negative amount is split as a positive one and each part
 * made negative, so a reversal mirrors the original.
 */
export function splitByPercentages(amount: string, percentages: readonly string[]): string[] {
  const value = dec(amount);
  if (significantScale(value) > 2) throw new ValidationError("The amount to split can have at most 2 decimal places.");
  for (const percentage of percentages) {
    if (!isPositive(dec(percentage))) throw new ValidationError("Each allocation line's percentage must be more than 0.");
  }
  assertTotalsOneHundred(percentages);

  const whole = abs(value);
  const exact = percentages.map((percentage) => divide(mul(whole, dec(percentage)), ONE_HUNDRED, 6));
  const parts = exact.map((share) => truncate(share, 2));
  const cutOff = exact.map((share, index) => sub(share, parts[index]));
  let leftOver = sub(whole, sum(parts));

  const order = cutOff
    .map((remainder, index) => ({ remainder, index }))
    .sort((left, right) => cmp(right.remainder, left.remainder) || left.index - right.index);
  for (const { index } of order) {
    if (cmp(leftOver, CENT) < 0) break;
    parts[index] = add(parts[index], CENT);
    leftOver = sub(leftOver, CENT);
  }

  return parts.map((part: Decimal) => toFixedString(isNegative(value) ? neg(part) : part, 2));
}
