import { ValidationError } from "@/lib/errors";

/**
 * Exact decimal arithmetic on top of BigInt. Money, quantities, rates and costs
 * never touch binary floating point.
 *
 * A Decimal is an integer `units` scaled by 10^scale, so 12.34 is
 * { units: 1234n, scale: 2 }. Values are plain strings at every boundary
 * (API, database) and only become Decimals inside calculations.
 */
export type Decimal = {
  readonly units: bigint;
  readonly scale: number;
};

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

function pow10(exponent: number): bigint {
  let result = ONE;
  for (let index = 0; index < exponent; index += 1) {
    result *= TEN;
  }
  return result;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value.trim());
}

/** Parses a canonical decimal string. Throws for anything that is not one. */
export function dec(value: string): Decimal {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new ValidationError(`"${value}" is not a valid decimal number.`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(`${whole}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

/** Rescales without losing information (only ever increases the scale). */
function widen(value: Decimal, scale: number): bigint {
  if (scale < value.scale) {
    throw new Error("widen() can only increase the scale.");
  }
  return value.units * pow10(scale - value.scale);
}

/** Canonical string: no trailing fractional zeros, no "-0". */
export function toPlainString(value: Decimal): string {
  let { units, scale } = value;
  while (scale > 0 && units % TEN === ZERO) {
    units /= TEN;
    scale -= 1;
  }
  const negative = units < ZERO;
  const digits = (negative ? -units : units).toString();
  if (scale === 0) {
    return negative ? `-${digits}` : digits;
  }
  const padded = digits.padStart(scale + 1, "0");
  const text = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** Fixed number of decimal places, e.g. toFixedString(dec("3.5"), 2) === "3.50". */
export function toFixedString(value: Decimal, scale: number): string {
  const rounded = roundHalfUp(value, scale);
  const negative = rounded.units < ZERO;
  const digits = (negative ? -rounded.units : rounded.units).toString();
  if (scale === 0) {
    return negative ? `-${digits}` : digits;
  }
  const padded = digits.padStart(scale + 1, "0");
  const text = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

export function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { units: widen(left, scale) + widen(right, scale), scale };
}

export function sub(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return { units: widen(left, scale) - widen(right, scale), scale };
}

export function mul(left: Decimal, right: Decimal): Decimal {
  return { units: left.units * right.units, scale: left.scale + right.scale };
}

export function neg(value: Decimal): Decimal {
  return { units: -value.units, scale: value.scale };
}

export function abs(value: Decimal): Decimal {
  return value.units < ZERO ? neg(value) : value;
}

export function cmp(left: Decimal, right: Decimal): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const a = widen(left, scale);
  const b = widen(right, scale);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function isZero(value: Decimal): boolean {
  return value.units === ZERO;
}

export function isNegative(value: Decimal): boolean {
  return value.units < ZERO;
}

export function isPositive(value: Decimal): boolean {
  return value.units > ZERO;
}

export const ZERO_DECIMAL: Decimal = { units: ZERO, scale: 0 };

/**
 * Integer division of a / b rounded half away from zero ("round half up" as
 * people normally mean it: 2.5 -> 3, -2.5 -> -3).
 */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === ZERO) {
    throw new Error("Division by zero.");
  }
  const negative = (numerator < ZERO) !== (denominator < ZERO);
  const n = numerator < ZERO ? -numerator : numerator;
  const d = denominator < ZERO ? -denominator : denominator;
  let quotient = n / d;
  const remainder = n % d;
  if (remainder * TWO >= d) {
    quotient += ONE;
  }
  return negative ? -quotient : quotient;
}

/** Rounds to `scale` decimal places, half away from zero. */
export function roundHalfUp(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) {
    return { units: widen(value, scale), scale };
  }
  const factor = pow10(value.scale - scale);
  return { units: divideRounded(value.units, factor), scale };
}

/**
 * numerator / denominator, rounded half up to `scale` places. Both operands can
 * have any scale; this is exact up to the final rounding.
 */
export function divide(numerator: Decimal, denominator: Decimal, scale: number): Decimal {
  if (denominator.units === ZERO) {
    throw new ValidationError("Cannot divide by zero.");
  }
  // (N / 10^ns) / (D / 10^ds) * 10^scale = N * 10^(ds + scale) / (D * 10^ns)
  const top = numerator.units * pow10(denominator.scale + scale);
  const bottom = denominator.units * pow10(numerator.scale);
  return { units: divideRounded(top, bottom), scale };
}

/**
 * Drops the digits after `scale` decimal places (towards zero, no rounding):
 * truncate(dec("75.678"), 2) is 75.67. IRD's payroll calculations truncate
 * rather than round.
 */
export function truncate(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) {
    return { units: widen(value, scale), scale };
  }
  return { units: value.units / pow10(value.scale - scale), scale };
}

/**
 * numerator / denominator truncated (towards zero) to `scale` places, exact
 * up to that point: divideTruncated(dec("3934.84"), dec("12"), 2) is 327.90.
 */
export function divideTruncated(numerator: Decimal, denominator: Decimal, scale: number): Decimal {
  if (denominator.units === ZERO) {
    throw new ValidationError("Cannot divide by zero.");
  }
  const top = numerator.units * pow10(denominator.scale + scale);
  const bottom = denominator.units * pow10(numerator.scale);
  return { units: top / bottom, scale };
}

/**
 * (a * b) / c rounded half up to `scale` places, with no intermediate rounding.
 * Used for "quantity x carrying value / on-hand quantity" style calculations.
 */
export function mulDiv(a: Decimal, b: Decimal, c: Decimal, scale: number): Decimal {
  return divide(mul(a, b), c, scale);
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((total, value) => add(total, value), ZERO_DECIMAL);
}

/** Number of decimal places actually used (trailing zeros ignored). */
export function significantScale(value: Decimal): number {
  const plain = toPlainString(value);
  const dot = plain.indexOf(".");
  return dot === -1 ? 0 : plain.length - dot - 1;
}

export type ParseDecimalOptions = {
  maxScale: number;
  allowNegative?: boolean;
  allowZero?: boolean;
};

/**
 * Validates user input and returns a canonical decimal string.
 * Accepts strings (and finite numbers for convenience in JSON bodies, which are
 * converted via their shortest string form, so 0.1 stays "0.1").
 */
export function parseDecimalInput(
  input: unknown,
  fieldName: string,
  options: ParseDecimalOptions,
): string {
  let text: string;
  if (typeof input === "string") {
    text = input.trim();
  } else if (typeof input === "number" && Number.isFinite(input)) {
    text = String(input);
  } else {
    throw new ValidationError(`${fieldName} must be a number.`);
  }
  if (text.length === 0) {
    throw new ValidationError(`${fieldName} is required.`);
  }
  if (!DECIMAL_PATTERN.test(text)) {
    throw new ValidationError(`${fieldName} must be a plain number like 12.34.`);
  }
  if (text.replace(/^-/, "").replace(".", "").length > 24) {
    throw new ValidationError(`${fieldName} is too large.`);
  }
  const value = dec(text);
  if (significantScale(value) > options.maxScale) {
    throw new ValidationError(
      options.maxScale === 0
        ? `${fieldName} must be a whole number.`
        : `${fieldName} can have at most ${options.maxScale} decimal places.`,
    );
  }
  if (!options.allowNegative && isNegative(value)) {
    throw new ValidationError(`${fieldName} can't be negative.`);
  }
  if (!options.allowZero && isZero(value)) {
    throw new ValidationError(`${fieldName} must not be zero.`);
  }
  return toPlainString(value);
}
