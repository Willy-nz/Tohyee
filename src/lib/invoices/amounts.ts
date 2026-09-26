import { add, dec, isZero, mul, mulDiv, roundHalfUp, sub, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";

// Browser-safe: the invoice editor uses this for its live totals, and the
// server uses it again when saving and approving.

export const AMOUNTS_MODES = ["exclusive", "inclusive", "no_tax"] as const;
export type AmountsMode = (typeof AMOUNTS_MODES)[number];

export const AMOUNTS_MODE_LABELS: Readonly<Record<AmountsMode, string>> = {
  exclusive: "Tax exclusive",
  inclusive: "Tax inclusive",
  no_tax: "No tax",
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
