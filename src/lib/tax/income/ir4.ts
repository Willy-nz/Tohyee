import { add, dec, type Decimal, isNegative, isPositive, neg, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { money, type Workpaper } from "@/lib/tax/income/rules";

/*
 * The IR4 company return's income and tax calculation boxes (examples
 * ITX50-ITX53, decision 553), from IRD's IR4 form for 2026 (March 2026
 * edition) and IR4 guide (IR4GU 2026), downloaded from ird.govt.nz on 17 Oct
 * 2026 and read by Claude, not yet reviewed. Pure and browser-safe. Only boxes the form itself
 * defines, filled from Tohyee's workpaper; boxes Tohyee has nothing for are
 * zero, and the notes say which those are.
 */

export const IR4_BOXES = ["20B", "23", "24B", "25", "26A", "26B", "27", "29", "30A", "30B", "30C", "30D", "30E", "30F", "30G", "30H", "30I", "30IA", "30J", "30K", "30L"] as const;
export type Ir4Box = (typeof IR4_BOXES)[number];

export const IR4_BOX_LABELS: Record<Ir4Box, string> = {
  "20B": "Net profit or loss from business or other rental",
  "23": "Total income before donations",
  "24B": "Donations made",
  "25": "Total income or net loss",
  "26A": "Net losses brought forward",
  "26B": "Net losses claimed this year",
  "27": "Total income after net losses",
  "29": "Taxable income",
  "30A": "Taxable income",
  "30B": "Tax at 28 cents in the dollar",
  "30C": "Overseas tax paid",
  "30D": "30B less 30C (not below 0)",
  "30E": "Foreign investor tax credit",
  "30F": "30D less 30E",
  "30G": "Imputation credits",
  "30H": "30F less 30G (not below 0)",
  "30I": "Total tax credits (box 17A)",
  "30IA": "RLWT credit",
  "30J": "Residual income tax (30H less 30I and 30IA)",
  "30K": "Provisional tax paid",
  "30L": "Refund, or tax to pay",
};

export type Ir4Return = {
  boxes: Record<Ir4Box, string>;
  /** Box 30J's tick: a debit when 30H is more than 30I and 30IA. Box 30J itself is shown positive. */
  residual: "credit" | "debit";
  /** Box 30L's tick. */
  outcome: "refund" | "tax_to_pay";
  notes: string[];
};

const atLeastZero = (value: Decimal) => (isNegative(value) ? ZERO_DECIMAL : value);

/**
 * The IR4's boxes 20B-30L for a company (ITX50-ITX53): 20B is the workpaper's
 * income before losses (the books' net profit plus tax adjustments); 26A and
 * 26B its losses brought forward and used; 30I the tax credits typed for the
 * year; 30C and 30G the overseas tax and imputation credits typed (ITX58-
 * ITX60); 30K what's recorded as paid towards the year. The form's own
 * arithmetic does the rest.
 */
export function ir4Return(input: { workpaper: Workpaper; paidTowardsYear: Decimal }): Ir4Return {
  const paper = input.workpaper;
  const box20B = dec(paper.beforeLosses);
  const box23 = box20B;
  const box24B = ZERO_DECIMAL;
  const box25 = sub(box23, box24B);
  const box26A = dec(paper.lossesBroughtForward);
  const box26B = dec(paper.lossesUsed);
  const box27 = sub(box25, box26B);
  const box29 = box27;
  const box30A = box29;
  const box30B = dec(paper.tax);
  const box30C = dec(paper.overseasTaxPaid);
  const box30D = atLeastZero(sub(box30B, box30C));
  const box30E = ZERO_DECIMAL;
  const box30F = sub(box30D, box30E);
  const box30G = dec(paper.imputationCredits);
  const box30H = atLeastZero(sub(box30F, box30G));
  const box30I = dec(paper.taxCredits);
  const box30IA = ZERO_DECIMAL;
  const signedJ = sub(box30H, add(box30I, box30IA));
  const residual = isPositive(signedJ) ? "debit" : "credit";
  const box30K = input.paidTowardsYear;
  // Credit: 30J + 30K is the refund. Debit: 30J - 30K is tax to pay, or a refund if 30K is larger. Both are 30J (debit positive) less 30K.
  const signedL = sub(signedJ, box30K);
  const outcome = isNegative(signedL) ? "refund" : "tax_to_pay";
  const boxes: Record<Ir4Box, string> = {
    "20B": money(box20B),
    "23": money(box23),
    "24B": money(box24B),
    "25": money(box25),
    "26A": money(box26A),
    "26B": money(box26B),
    "27": money(box27),
    "29": money(box29),
    "30A": money(box30A),
    "30B": money(box30B),
    "30C": money(box30C),
    "30D": money(box30D),
    "30E": money(box30E),
    "30F": money(box30F),
    "30G": money(box30G),
    "30H": money(box30H),
    "30I": money(box30I),
    "30IA": money(box30IA),
    "30J": money(isNegative(signedJ) ? neg(signedJ) : signedJ),
    "30K": money(box30K),
    "30L": money(isNegative(signedL) ? neg(signedL) : signedL),
  };
  return {
    boxes,
    residual,
    outcome,
    notes: [
      "Box 20B holds all the books' income after tax adjustments. Interest, dividends, overseas income, residential rental and property sales belong in boxes 13 to 21 instead; moving them there doesn't change box 23.",
      "Box 30I is the tax credits typed for the year (RWT and other credits, box 17A); 30C the overseas tax paid (box 18A) and 30G the imputation credits received (box 14), as typed. Imputation credits more than 30F become a loss to carry forward (the excess ÷ 0.28, IR4 guide), shown on the workpaper.",
      "Tohyee has nothing for donations (24B: the IR4 guide caps them at box 23, and nil when 23 is a loss), group loss offsets and subvention payments (28, 28A), the foreign investor tax credit (30E) or RLWT (30IA), so they're 0.00.",
      "Box 27 is 25 less 26B, as the IR4 guide says. Tohyee doesn't check the shareholder continuity or business continuity tests (26C).",
      "The paper form prints 30A in whole dollars. Neither the form nor the guide says whether to drop or round the cents, so Tohyee shows them and works the tax on the full figure.",
      "Box 30K is every payment recorded towards this income year, including any end-of-year tax already paid.",
      "2027 provisional tax (boxes 32 and 33), the disclosures (34-39) and shareholder details (40) aren't filled.",
    ],
  };
}
