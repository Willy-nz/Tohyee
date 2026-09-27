import {
  add,
  dec,
  isPositive,
  isZero,
  mul,
  mulDiv,
  roundHalfUp,
  sub,
  toFixedString,
  ZERO_DECIMAL,
  type Decimal,
} from "@/lib/money/decimal";

// Browser-safe: the invoice editor uses this for its live totals, and the
// server uses it again when saving and approving, and to work out what's
// still due. Credit notes use the same line maths.

export const AMOUNTS_MODES = ["exclusive", "inclusive", "no_tax"] as const;
export type AmountsMode = (typeof AMOUNTS_MODES)[number];

export const AMOUNTS_MODE_LABELS: Readonly<Record<AmountsMode, string>> = {
  exclusive: "Tax exclusive",
  inclusive: "Tax inclusive",
  no_tax: "No tax",
};

/** Whether an approved invoice has been paid. Worked out from its payments, never stored. */
export const PAID_STATUSES = ["unpaid", "part_paid", "paid"] as const;
export type PaidStatus = (typeof PAID_STATUSES)[number];

export const PAID_STATUS_LABELS: Readonly<Record<PaidStatus, string>> = {
  unpaid: "Unpaid",
  part_paid: "Part paid",
  paid: "Paid",
};

export type InvoiceLineInput = {
  /** Plain decimal strings; the rate is a fraction (0.15 for 15%). */
  quantity: string;
  unitPrice: string;
  taxRate: string;
};

export type InvoiceLineAmounts = {
  /** Quantity x unit price, as entered (includes GST in inclusive mode). */
  lineAmount: string;
  /** The amount credited to the line's revenue account. */
  netAmount: string;
  taxAmount: string;
};

export type InvoiceAmounts = {
  lines: InvoiceLineAmounts[];
  subtotal: string;
  taxTotal: string;
  total: string;
};

const ONE = dec("1");

/**
 * The single place invoice amounts are rounded (worked examples I1-I6 in
 * docs/ACCOUNTING-EXAMPLES.md):
 *
 * - line amount = quantity x unit price, rounded once to the currency's minor
 *   units, half away from zero;
 * - GST is worked out and rounded on each line, then added up. Exclusive:
 *   line amount x rate. Inclusive: line amount x rate / (1 + rate), with the
 *   net being the line amount less its GST. No tax: none.
 *
 * Per-line rounding was chosen to match Xero and the owner is still
 * confirming it; if it changes to rounding the invoice total instead, this is
 * the function to change.
 */
export function calculateInvoice(mode: AmountsMode, lines: readonly InvoiceLineInput[], scale: number): InvoiceAmounts {
  let subtotal: Decimal = ZERO_DECIMAL;
  let taxTotal: Decimal = ZERO_DECIMAL;
  const results = lines.map((line) => {
    const lineAmount = roundHalfUp(mul(dec(line.quantity), dec(line.unitPrice)), scale);
    const rate = dec(line.taxRate);
    let taxAmount: Decimal = ZERO_DECIMAL;
    if (mode !== "no_tax" && !isZero(rate)) {
      taxAmount =
        mode === "exclusive" ? roundHalfUp(mul(lineAmount, rate), scale) : mulDiv(lineAmount, rate, add(ONE, rate), scale);
    }
    const netAmount = mode === "inclusive" ? sub(lineAmount, taxAmount) : lineAmount;
    subtotal = add(subtotal, netAmount);
    taxTotal = add(taxTotal, taxAmount);
    return {
      lineAmount: toFixedString(lineAmount, scale),
      netAmount: toFixedString(netAmount, scale),
      taxAmount: toFixedString(taxAmount, scale),
    };
  });
  return {
    lines: results,
    subtotal: toFixedString(subtotal, scale),
    taxTotal: toFixedString(taxTotal, scale),
    total: toFixedString(add(subtotal, taxTotal), scale),
  };
}

export type InvoicePaymentStatus = {
  amountPaid: string;
  amountDue: string;
  paidStatus: PaidStatus;
};

/**
 * What's still due on an approved invoice, from its total, the sum of its
 * active (not voided) payments and the sum of the credit applied to it from
 * credit notes (worked examples CP1, CP2, CP4 and CN3): unpaid while nothing
 * is paid or credited, part paid while something is still due, then paid.
 * Payments and credit can't add up to more than the total, so nothing is ever
 * overpaid.
 */
export function invoicePaymentStatus(
  total: string,
  amountPaid: string,
  scale: number,
  amountCredited = "0",
): InvoicePaymentStatus {
  const paid = dec(amountPaid);
  const credited = dec(amountCredited);
  const settled = add(paid, credited);
  const due = sub(dec(total), settled);
  return {
    amountPaid: toFixedString(paid, scale),
    amountDue: toFixedString(due, scale),
    paidStatus: isZero(settled) ? "unpaid" : isPositive(due) ? "part_paid" : "paid",
  };
}

/** How much of an approved credit note has been used. Worked out from its applications and refunds, never stored. */
export const CREDIT_STATUSES = ["open", "part_used", "used"] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const CREDIT_STATUS_LABELS: Readonly<Record<CreditStatus, string>> = {
  open: "Open",
  part_used: "Part used",
  used: "Used",
};

export type CreditNoteCreditStatus = {
  amountApplied: string;
  amountRefunded: string;
  remainingCredit: string;
  creditStatus: CreditStatus;
};

/**
 * What's left of an approved credit note (worked examples CN2-CN4, CN7 and
 * CN8): its total less its active applications and active refunds. Open while
 * none of it is used, part used while some credit remains, then used.
 */
export function creditNoteCreditStatus(
  total: string,
  amountApplied: string,
  amountRefunded: string,
  scale: number,
): CreditNoteCreditStatus {
  const applied = dec(amountApplied);
  const refunded = dec(amountRefunded);
  const used = add(applied, refunded);
  const remaining = sub(dec(total), used);
  return {
    amountApplied: toFixedString(applied, scale),
    amountRefunded: toFixedString(refunded, scale),
    remainingCredit: toFixedString(remaining, scale),
    creditStatus: isZero(used) ? "open" : isPositive(remaining) ? "part_used" : "used",
  };
}
