import { add, dec, type Decimal, mul, mulDiv, roundHalfUp, sub, toFixedString } from "@/lib/money/decimal";

/*
 * The owner's rations (homekill) as one adjustment a year (examples RAT5-RAT8,
 * decision 624; Jess, 20 October 2026: "Home kill the accountant just does a
 * jnl adjustment like 500 bucks"). Pure and browser-safe. The amount is the
 * accountant's; GST only on a GST-registered date, when they say it applies.
 */

/** GST in an amount: 15% of one excluding GST, 3/23 of one including it. */
export function rationsGst(amount: Decimal, includesGst: boolean): { net: Decimal; gst: Decimal } {
  if (includesGst) {
    const gst = mulDiv(amount, dec("3"), dec("23"), 2);
    return { net: sub(amount, gst), gst };
  }
  return { net: amount, gst: roundHalfUp(mul(amount, dec("0.15")), 2) };
}

/** What the yearly adjustment posts: Dr drawings (or the owner's current account), Cr rations income, Cr GST. */
export function rationsAdjustmentPosting(input: { amount: Decimal; gstApplies: boolean; includesGst: boolean }): { drawings: string; income: string; gst: string } {
  const text = (value: Decimal) => toFixedString(value, 2);
  if (!input.gstApplies) return { drawings: text(input.amount), income: text(input.amount), gst: "0.00" };
  const { net, gst } = rationsGst(input.amount, input.includesGst);
  return { drawings: text(add(net, gst)), income: text(net), gst: text(gst) };
}
