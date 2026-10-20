import { add, dec, type Decimal, isPositive, mul, mulDiv, roundHalfUp, sub, toFixedString } from "@/lib/money/decimal";

/*
 * GST on the owner's rations (examples RAT1, RAT5-RAT10, decisions
 * 624-627; Codex, delegated by owner (via Will), 20 October 2026, from the
 * 20 Oct comment on #292, section 2). Pure and browser-safe.
 *
 * A GST-registered farm assesses each owner's rations event. Until it does,
 * the event is unresolved: shown in GST return preparation, never as a
 * verified nil. The outcomes:
 * - a confirmed taxable supply (to an associated person who can't claim the
 *   GST, at market value): GST is 15% of a value excluding GST, or 3/23 of a
 *   value including it;
 * - a confirmed change-in-use adjustment: a reviewed GST amount, typed with
 *   its basis, while the sole-trader rule is being verified;
 * - evidenced no adjustment: no GST, with the evidence.
 * There's never an input GST claim, and no bank movement is assumed.
 */

export const RATIONS_GST_OUTCOMES = ["taxable_supply", "change_in_use", "no_adjustment"] as const;
export type RationsGstOutcome = (typeof RATIONS_GST_OUTCOMES)[number];
export const RATIONS_GST_OUTCOME_LABELS: Record<RationsGstOutcome, string> = {
  taxable_supply: "Confirmed taxable supply",
  change_in_use: "Confirmed change-in-use adjustment",
  no_adjustment: "No GST adjustment (with evidence)",
};

/** Where an owner's rations event stands for GST. */
export type RationsGstStatus = "not_registered" | "unresolved" | RationsGstOutcome;
export const RATIONS_GST_STATUS_LABELS: Record<RationsGstStatus, string> = {
  not_registered: "Not GST-registered on that date",
  unresolved: "Not assessed yet",
  ...RATIONS_GST_OUTCOME_LABELS,
};

const RATE = dec("0.15");
const THREE = dec("3");
const TWENTY_THREE = dec("23");

/** GST on a taxable supply at this value: 15% of a value excluding GST, 3/23 of one including it (RAT5, RAT6). */
export function supplyGst(value: Decimal, includesGst: boolean): { net: Decimal; gst: Decimal } {
  if (includesGst) {
    const gst = mulDiv(value, THREE, TWENTY_THREE, 2);
    return { net: sub(value, gst), gst };
  }
  return { net: value, gst: roundHalfUp(mul(value, RATE), 2) };
}

/** The rations journal's amounts: Dr drawings (or the owner's current account), Cr rations income, Cr GST payable. */
export type RationsPosting = { drawings: string; income: string; gst: string };

/**
 * What the owner's rations journal posts for an assessment (RAT1, RAT5-RAT8).
 * Unresolved, not registered and no adjustment: the value, with no GST. A
 * taxable supply: the GST from `supplyGst`. A change-in-use adjustment: the
 * reviewed GST on top of the value excluding GST.
 */
export function rationsPosting(input: { value: Decimal; includesGst: boolean; status: RationsGstStatus; reviewedGst?: Decimal | null }): RationsPosting {
  const text = (value: Decimal) => toFixedString(value, 2);
  if (input.status === "taxable_supply") {
    const { net, gst } = supplyGst(input.value, input.includesGst);
    return { drawings: text(add(net, gst)), income: text(net), gst: text(gst) };
  }
  if (input.status === "change_in_use") {
    const gst = input.reviewedGst ?? null;
    if (!gst || !isPositive(gst)) throw new Error("A change-in-use adjustment needs its reviewed GST amount.");
    const net = input.includesGst ? supplyGst(input.value, true).net : input.value;
    return { drawings: text(add(net, gst)), income: text(net), gst: text(gst) };
  }
  return { drawings: text(input.value), income: text(input.value), gst: "0.00" };
}
