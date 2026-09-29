import { ValidationError } from "@/lib/errors";
import {
  add,
  cmp,
  dec,
  type Decimal,
  divide,
  isNegative,
  isPositive,
  isZero,
  mul,
  mulDiv,
  neg,
  roundHalfUp,
  sub,
  toPlainString,
} from "@/lib/money/decimal";

/**
 * Weighted-average stock costing, as a pure function so the worked examples in
 * docs/ACCOUNTING-EXAMPLES.md can be tested exactly.
 *
 * Rules:
 * - The carrying value is always a whole number of cents (currency minor units),
 *   so the inventory balance equals the ledger balance to the cent.
 * - Stock going out is valued at quantity x carrying value / quantity on hand,
 *   computed exactly and rounded once, half away from zero, to cents.
 * - Taking out everything that's left takes the whole remaining value, so no
 *   stray fractions of a cent are ever left behind at zero stock.
 * - Stock can't go negative, unless the organisation allows it (ST9-ST12).
 *   Then stock going out with nothing on hand is costed at the last cost
 *   there, else the item's purchase price (ST11), and stock coming in while
 *   below zero first fills the shortfall: the difference between what the
 *   filled units cost and the value they went out at is a cost of sales
 *   adjustment (ST10).
 */

export type Balance = {
  quantity: string;
  value: string;
};

export type OriginalIssue = {
  /** Positive quantity that was issued. */
  quantity: string;
  /** Positive value that was issued. */
  value: string;
  /** Totals already returned against this issue. */
  returnedQuantity: string;
  returnedValue: string;
};

export type CostingInput =
  /** A receipt at a unit cost, or at a value already worked out (a bill line's net amount, ST1). */
  | { type: "receipt"; quantity: string; unitCost?: string; value?: string }
  | { type: "issue"; quantity: string }
  | { type: "supplier_return"; quantity: string }
  | { type: "adjustment"; quantityDelta: string; unitCost?: string | null }
  | { type: "customer_return"; quantity: string; original: OriginalIssue }
  | { type: "landed_cost"; amount: string }
  /** Exactly undoes an earlier movement (a voided bill or credit note), which must be the latest one there. */
  | { type: "reversal"; quantityDelta: string; valueDelta: string; costAdjustment: string };

export type CostingOptions = {
  /** Whether stock may go below zero (the organisation's setting, ST9-ST12). */
  allowNegative?: boolean;
  /** With negative stock allowed and nothing on hand: the unit cost to use (ST11), or null for none. */
  fallbackUnitCost?: string | null;
};

export type CostingResult = {
  quantityDelta: string;
  valueDelta: string;
  /** Unit cost used for this movement, for display (6 decimal places). */
  unitCost: string | null;
  quantityAfter: string;
  valueAfter: string;
  /**
   * Stock coming in while below zero (ST10): what the filled units cost less
   * the value they went out at. Positive is more cost of sales (Dr cost of
   * sales / Cr inventory). "0" otherwise. The stock value changes by
   * valueDelta, which already allows for it.
   */
  costAdjustment: string;
};

const UNIT_COST_DISPLAY_SCALE = 6;
const ZERO = dec("0");

function outgoingWithOptions(
  balance: { quantity: Decimal; value: Decimal },
  quantity: Decimal,
  moneyScale: number,
  options: CostingOptions,
): Decimal {
  if (!options.allowNegative || isPositive(balance.quantity) && cmp(quantity, balance.quantity) <= 0) {
    return outgoingValue(balance, quantity, moneyScale);
  }
  if (isZero(balance.quantity)) {
    if (!options.fallbackUnitCost) {
      throw new ValidationError(
        "There's no stock here and no cost to use for it: it has never been received here and the item has no purchase price. Receive it first, or give the item a purchase price.",
      );
    }
    return roundHalfUp(mul(quantity, dec(options.fallbackUnitCost)), moneyScale);
  }
  // Above zero and going below it, or already below zero: at the average (ST10).
  return mulDiv(quantity, balance.value, balance.quantity, moneyScale);
}

/**
 * Stock coming in (ST10): above zero it simply adds its value. Below zero it
 * first fills the shortfall; the filled units' share of the value, less the
 * value they went out at, is the cost adjustment.
 */
function incoming(
  balance: { quantity: Decimal; value: Decimal },
  quantity: Decimal,
  value: Decimal,
  moneyScale: number,
): { valueDelta: Decimal; costAdjustment: Decimal } {
  if (!isNegative(balance.quantity)) {
    return { valueDelta: value, costAdjustment: ZERO };
  }
  const shortfall = neg(balance.quantity);
  const issuedValue = neg(balance.value);
  if (cmp(quantity, shortfall) >= 0) {
    const filled = cmp(quantity, shortfall) === 0 ? value : mulDiv(value, shortfall, quantity, moneyScale);
    const costAdjustment = sub(filled, issuedValue);
    return { valueDelta: sub(value, costAdjustment), costAdjustment };
  }
  const issuedShare = mulDiv(issuedValue, quantity, shortfall, moneyScale);
  return { valueDelta: issuedShare, costAdjustment: sub(value, issuedShare) };
}

function outgoingValue(balance: { quantity: Decimal; value: Decimal }, quantity: Decimal, moneyScale: number) {
  if (isZero(balance.quantity)) {
    throw new ValidationError("There's no stock on hand to take out.");
  }
  const comparison = cmp(quantity, balance.quantity);
  if (comparison > 0) {
    throw new ValidationError(
      `Only ${toPlainString(balance.quantity)} on hand, so ${toPlainString(quantity)} can't be taken out. Stock can't go negative.`,
    );
  }
  if (comparison === 0) {
    return balance.value;
  }
  return mulDiv(quantity, balance.value, balance.quantity, moneyScale);
}

export function applyMovement(
  balanceInput: Balance,
  input: CostingInput,
  moneyScale: number,
  options: CostingOptions = {},
): CostingResult {
  const balance = { quantity: dec(balanceInput.quantity), value: dec(balanceInput.value) };
  let quantityDelta: Decimal;
  let valueDelta: Decimal;
  let unitCost: Decimal | null;
  let costAdjustment: Decimal = ZERO;

  switch (input.type) {
    case "receipt": {
      const quantity = dec(input.quantity);
      quantityDelta = quantity;
      const value =
        input.value !== undefined ? dec(input.value) : roundHalfUp(mul(quantity, dec(input.unitCost ?? "0")), moneyScale);
      if (isZero(value)) {
        throw new ValidationError("This movement's value rounds to zero, so there's nothing to post.");
      }
      ({ valueDelta, costAdjustment } = incoming(balance, quantity, value, moneyScale));
      unitCost = input.value !== undefined ? divide(value, quantity, UNIT_COST_DISPLAY_SCALE) : dec(input.unitCost ?? "0");
      break;
    }
    case "reversal": {
      quantityDelta = neg(dec(input.quantityDelta));
      valueDelta = neg(dec(input.valueDelta));
      costAdjustment = neg(dec(input.costAdjustment));
      unitCost = null;
      break;
    }
    case "issue":
    case "supplier_return": {
      const quantity = dec(input.quantity);
      const value = outgoingWithOptions(balance, quantity, moneyScale, options);
      quantityDelta = neg(quantity);
      valueDelta = neg(value);
      unitCost = divide(value, quantity, UNIT_COST_DISPLAY_SCALE);
      break;
    }
    case "adjustment": {
      const delta = dec(input.quantityDelta);
      if (isNegative(delta)) {
        const quantity = neg(delta);
        const value = outgoingWithOptions(balance, quantity, moneyScale, options);
        quantityDelta = delta;
        valueDelta = neg(value);
        unitCost = divide(value, quantity, UNIT_COST_DISPLAY_SCALE);
      } else {
        if (!input.unitCost) {
          throw new ValidationError("A stock increase needs a unit cost.");
        }
        quantityDelta = delta;
        ({ valueDelta, costAdjustment } = incoming(balance, delta, roundHalfUp(mul(delta, dec(input.unitCost)), moneyScale), moneyScale));
        unitCost = dec(input.unitCost);
      }
      break;
    }
    case "customer_return": {
      const quantity = dec(input.quantity);
      const originalQuantity = dec(input.original.quantity);
      const returnedSoFar = dec(input.original.returnedQuantity);
      const remaining = sub(originalQuantity, returnedSoFar);
      const comparison = cmp(quantity, remaining);
      if (comparison > 0) {
        throw new ValidationError(
          `Only ${toPlainString(remaining)} of that sale can still be returned.`,
        );
      }
      // Restock at the original issue cost. The last return takes whatever
      // value is left, so returns add back exactly what the sale took out.
      const value =
        comparison === 0
          ? sub(dec(input.original.value), dec(input.original.returnedValue))
          : mulDiv(quantity, dec(input.original.value), originalQuantity, moneyScale);
      quantityDelta = quantity;
      ({ valueDelta, costAdjustment } = incoming(balance, quantity, value, moneyScale));
      unitCost = divide(dec(input.original.value), originalQuantity, UNIT_COST_DISPLAY_SCALE);
      break;
    }
    case "landed_cost": {
      if (!isPositive(balance.quantity)) {
        throw new ValidationError("Landed cost needs stock on hand to add the cost to.");
      }
      quantityDelta = dec("0");
      valueDelta = dec(input.amount);
      unitCost = null;
      break;
    }
  }

  const quantityAfter = add(balance.quantity, quantityDelta);
  const valueAfter = add(balance.value, valueDelta);
  if (isNegative(quantityAfter) && !options.allowNegative && input.type !== "reversal") {
    throw new ValidationError("Stock can't go negative.");
  }
  if (isNegative(valueAfter) && !options.allowNegative && input.type !== "reversal") {
    throw new ValidationError("The stock value can't go negative.");
  }
  if (isZero(valueDelta) && isZero(costAdjustment)) {
    throw new ValidationError("This movement's value rounds to zero, so there's nothing to post.");
  }

  return {
    quantityDelta: toPlainString(quantityDelta),
    valueDelta: toPlainString(valueDelta),
    unitCost: unitCost === null ? null : toPlainString(unitCost),
    quantityAfter: toPlainString(quantityAfter),
    valueAfter: toPlainString(valueAfter),
    costAdjustment: toPlainString(costAdjustment),
  };
}
