import { add, cmp, dec, type Decimal, divide, isZero, mul, neg, sum, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Leave balances kept exactly (decisions 8, 9 and 26). Every leave entry
 * stores its hours and the hours in one unit at the time (a usual week for
 * annual holidays, a usual day for sick, bereavement, family violence and
 * alternative holidays), so a unit is hours ÷ unit hours: Ben's Thursday is
 * 13 ÷ 45 week. A balance is the sum of such fractions, kept as hours per
 * unit size so nothing is rounded until it's shown: four Wednesdays
 * (4 × 8 ÷ 45) and a Thursday (13 ÷ 45) make exactly 1 week. Browser-safe.
 */

export type LeaveQuantity = ReadonlyMap<string, Decimal>;

export const NO_LEAVE: LeaveQuantity = new Map();

/** `hours` of leave where one unit is `unitHours` hours. */
export function leaveHours(hours: string | Decimal, unitHours: string | Decimal): LeaveQuantity {
  const per = typeof unitHours === "string" ? dec(unitHours) : unitHours;
  if (cmp(per, ZERO_DECIMAL) <= 0) throw new Error("A unit of leave must have more than 0 hours.");
  return new Map([[toPlainString(per), typeof hours === "string" ? dec(hours) : hours]]);
}

/** `units` whole units (4 weeks, 10 days) of `unitHours` each. */
export function leaveUnits(units: string, unitHours: string): LeaveQuantity {
  return leaveHours(mul(dec(units), dec(unitHours)), unitHours);
}

export function addLeave(...quantities: LeaveQuantity[]): LeaveQuantity {
  const result = new Map<string, Decimal>();
  for (const quantity of quantities) {
    for (const [per, hours] of quantity) result.set(per, add(result.get(per) ?? ZERO_DECIMAL, hours));
  }
  for (const [per, hours] of [...result]) if (isZero(hours)) result.delete(per);
  return result;
}

export function negateLeave(quantity: LeaveQuantity): LeaveQuantity {
  return new Map([...quantity].map(([per, hours]) => [per, neg(hours)]));
}

export function subtractLeave(left: LeaveQuantity, right: LeaveQuantity): LeaveQuantity {
  return addLeave(left, negateLeave(right));
}

/** The exact value as numerator ÷ denominator (denominator > 0). */
function fraction(quantity: LeaveQuantity): { numerator: Decimal; denominator: Decimal } {
  const entries = [...quantity];
  if (entries.length === 0) return { numerator: ZERO_DECIMAL, denominator: dec("1") };
  const pers = entries.map(([per]) => dec(per));
  const denominator = pers.reduce((product, per) => mul(product, per), dec("1"));
  const numerator = sum(
    entries.map(([, hours], index) => pers.reduce((product, per, other) => (other === index ? product : mul(product, per)), hours)),
  );
  return { numerator, denominator };
}

/** The number of units, rounded half up to `scale` places (for showing and storing; balances stay exact). */
export function unitsOf(quantity: LeaveQuantity, scale = 8): Decimal {
  const { numerator, denominator } = fraction(quantity);
  return divide(numerator, denominator, scale);
}

/** -1, 0 or 1, exactly. */
export function signOfLeave(quantity: LeaveQuantity): -1 | 0 | 1 {
  return cmp(fraction(quantity).numerator, ZERO_DECIMAL);
}

/** Compares two quantities exactly. */
export function compareLeave(left: LeaveQuantity, right: LeaveQuantity): -1 | 0 | 1 {
  return signOfLeave(subtractLeave(left, right));
}

/** The quantity in hours of a given unit size (a balance in weeks shown in today's usual weekly hours). */
export function hoursAt(quantity: LeaveQuantity, unitHours: string, scale = 8): Decimal {
  const { numerator, denominator } = fraction(quantity);
  return divide(mul(numerator, dec(unitHours)), denominator, scale);
}

/** The smaller of two quantities. */
export function minLeave(left: LeaveQuantity, right: LeaveQuantity): LeaveQuantity {
  return compareLeave(left, right) <= 0 ? left : right;
}
