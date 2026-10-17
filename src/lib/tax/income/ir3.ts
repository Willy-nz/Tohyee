import { add, dec, type Decimal, isNegative, isPositive, neg, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { money, type Workpaper } from "@/lib/tax/income/rules";

/*
 * The IR3 individual return's income boxes and the guide's Question 36 tax
 * calculation worksheet, for a sole trader (examples ITX54-ITX57, decision
 * 554), from IRD's IR3 form and IR3 guide (IR3G) for 2026, downloaded from
 * ird.govt.nz on 17 Oct 2026 and read by Claude, not yet reviewed. Pure and
 * browser-safe. Only boxes the form and worksheet define, filled from
 * Tohyee's workpaper; boxes Tohyee has nothing for are zero, with notes.
 */

export const IR3_BOXES = ["24", "other", "28", "29", "30", "31A", "31B", "32", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12", "W13", "W14", "W15", "W16"] as const;
export type Ir3Box = (typeof IR3_BOXES)[number];

export const IR3_BOX_LABELS: Record<Ir3Box, string> = {
  "24": "Self-employed net income",
  other: "Other income typed in Tohyee (put it in its own box: 11B, 13B, 14B, 23, 27…)",
  "28": "Total income",
  "29": "Other expenses claimed",
  "30": "Income after expenses",
  "31A": "Net losses brought forward",
  "31B": "Net losses claimed this year",
  "32": "Taxable income",
  W1: "Worksheet 1: taxable income (0.00 if a loss)",
  W2: "Worksheet 2: tax on taxable income (return box 36)",
  W3: "Worksheet 3: independent earner tax credit (box 33)",
  W4: "Worksheet 4: 2 less 3 (not below 0)",
  W5: "Worksheet 5: overseas tax paid (box 17A)",
  W6: "Worksheet 6: 4 less 5 (not below 0)",
  W7: "Worksheet 7: imputation credits (box 14)",
  W8: "Worksheet 8: excess imputation credits brought forward (box 34)",
  W9: "Worksheet 9: 7 plus 8",
  W10: "Worksheet 10: 6 less 9 (not below 0)",
  W11: "Worksheet 11: overpaid PIE tax",
  W12: "Worksheet 12: tax credit subtotal (box 21A)",
  W13: "Worksheet 13: 11 plus 12",
  W14: "Worksheet 14: residual income tax (return box 36A)",
  W15: "Worksheet 15: provisional tax paid",
  W16: "Worksheet 16: refund, or tax to pay (return box 36B)",
};

export type Ir3Return = {
  boxes: Record<Ir3Box, string>;
  /** Worksheet box 14's tick: a debit when 10 is more than 13. Box 14 itself is shown positive. */
  residual: "credit" | "debit";
  /** Worksheet box 16's tick. */
  outcome: "refund" | "tax_to_pay";
  notes: string[];
};

const atLeastZero = (value: Decimal) => (isNegative(value) ? ZERO_DECIMAL : value);
const unsigned = (value: Decimal) => (isNegative(value) ? neg(value) : value);

/**
 * The IR3 for a sole trader (ITX54-ITX57): 24 is the workpaper's business
 * income after tax adjustments; the other income typed in Tohyee is shown
 * separately and added into 28; 31A and 31B the losses brought forward and
 * used; worksheet 2 the workpaper's tax; worksheet 12 the tax credits typed
 * for the year; worksheet 15 what's recorded as paid towards the year.
 */
export function ir3Return(input: { workpaper: Workpaper; paidTowardsYear: Decimal }): Ir3Return {
  const paper = input.workpaper;
  const other = dec(paper.otherIncome);
  const box28 = dec(paper.beforeLosses);
  const box24 = sub(box28, other);
  const box29 = ZERO_DECIMAL;
  const box30 = sub(box28, box29);
  const box31A = dec(paper.lossesBroughtForward);
  const box31B = dec(paper.lossesUsed);
  const box32 = sub(box30, box31B);
  const w1 = atLeastZero(box32);
  const w2 = dec(paper.tax);
  const w3 = ZERO_DECIMAL;
  const w4 = atLeastZero(sub(w2, w3));
  const w5 = dec(paper.overseasTaxPaid);
  const w6 = atLeastZero(sub(w4, w5));
  const w7 = dec(paper.imputationCredits);
  const w8 = ZERO_DECIMAL;
  const w9 = add(w7, w8);
  const w10 = atLeastZero(sub(w6, w9));
  const w11 = ZERO_DECIMAL;
  const w12 = dec(paper.taxCredits);
  const w13 = add(w11, w12);
  const signed14 = sub(w10, w13);
  const residual = isPositive(signed14) ? "debit" : "credit";
  const w15 = input.paidTowardsYear;
  // Credit: 14 plus 15 is the refund. Debit: 14 less 15 is tax to pay, or a refund if 15 is larger. Both are 14 (debit positive) less 15.
  const signed16 = sub(signed14, w15);
  const outcome = isNegative(signed16) ? "refund" : "tax_to_pay";
  const boxes: Record<Ir3Box, string> = {
    "24": money(box24),
    other: money(other),
    "28": money(box28),
    "29": money(box29),
    "30": money(box30),
    "31A": money(box31A),
    "31B": money(box31B),
    "32": money(box32),
    W1: money(w1),
    W2: money(w2),
    W3: money(w3),
    W4: money(w4),
    W5: money(w5),
    W6: money(w6),
    W7: money(w7),
    W8: money(w8),
    W9: money(w9),
    W10: money(w10),
    W11: money(w11),
    W12: money(w12),
    W13: money(w13),
    W14: money(unsigned(signed14)),
    W15: money(w15),
    W16: money(unsigned(signed16)),
  };
  return {
    boxes,
    residual,
    outcome,
    notes: [
      "Box 24 holds all the books' income after tax adjustments. Interest, dividends, rents and property sales belong in their own boxes (13, 14, 22, 23, 25) instead; moving them doesn't change box 28.",
      "The other income typed in Tohyee is one figure, so put it in the box that fits it (salary or wages from your summary of income in 11B, interest in 13B, and so on). It's in box 28 either way.",
      "Worksheet box 12 is the tax credits typed for the year (the box 21A subtotal: PAYE, RWT and other credits); 5 the overseas tax paid and 7 the imputation credits received, as typed. Imputation credits more than worksheet 6 carry forward to next year's box 34 (the guide's excess imputation credits worksheet), shown on the workpaper. Tohyee doesn't hold last year's excess yet, so worksheet 8 is 0.00.",
      "Tohyee doesn't work out the independent earner tax credit (worksheet 3), PIE income (35), the ACC earners' levy, Working for Families or student loan repayments, so those are 0.00 or left out. Donations are claimed on an IR526, not in the IR3.",
      "Box 29 is 0.00 because the business's expenses are already in box 24.",
      "The worksheet prints box 1 in whole dollars. Neither the form nor the guide says whether to drop or round the cents, so Tohyee shows them and works the tax on the full figure.",
      "Worksheet box 15 is every payment recorded towards this income year, including any end-of-year tax already paid.",
      "2027 provisional tax (box 39), foreign rights (40) and part-year returns (41) aren't filled.",
    ],
  };
}
