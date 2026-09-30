import { ValidationError } from "@/lib/errors";
import { abs, add, cmp, dec, type Decimal, isNegative, isPositive, isZero, mul, mulDiv, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { TaxCategory } from "@/lib/tax/categories";

/**
 * The GST in an open invoice or bill at the conversion date (examples IM13,
 * IM17-IM20), from what the file gives: the GST in what's still owed, the
 * whole document's GST with its total (the GST owed is then in proportion,
 * like `gstInOutstanding`), or a GST code (standard: 3/23 of what's owed).
 * The document becomes one line, or two when the GST is less than 3/23 of
 * what's owed: a standard-rated part (GST x 23 / 3) and the rest with no GST.
 * Pure, so it's unit tested on its own.
 */

export type OpeningTaxCode = { code: string; category: TaxCategory; rate: string };

export type OpeningLine = {
  /** Including GST. */
  amount: string;
  gst: string;
  taxCode: string | null;
  rate: string;
  /** "standard" for the part with GST, "rest" for a split's part without, null when there's one line. */
  part: "standard" | "rest" | null;
};

export type OpeningGst = {
  /** Null when the file says nothing about GST (only allowed where it never counts). */
  gst: string | null;
  lines: OpeningLine[];
};

/** How far the GST given may be from 3/23 of what's owed and still be one standard-rated line (line-by-line rounding). */
export const GST_ROUNDING_ALLOWANCE = "0.05";

const money = (value: Decimal) => toFixedString(value, 2);

export function openingDocumentGst(input: {
  noun: "invoice" | "bill";
  amount: string;
  gst: string | null;
  total: string | null;
  taxCode: OpeningTaxCode | null;
  /** The organisation's standard-rated code, used when only a GST amount is given. */
  standard: OpeningTaxCode | null;
}): OpeningGst {
  const amount = dec(input.amount);
  const noun = input.noun;
  if (input.total !== null) {
    const total = dec(input.total);
    if (!isPositive(total)) throw new ValidationError(`The ${noun} total must be more than 0.00.`);
    if (cmp(total, amount) < 0) throw new ValidationError(`The ${noun} total (${money(total)}) is less than what's still owed (${money(amount)}).`);
    if (input.gst === null) throw new ValidationError(`The ${noun} total is only used with a GST column (the whole ${noun}'s GST).`);
  }
  let gst: Decimal | null = null;
  if (input.gst !== null) {
    const given = dec(input.gst);
    if (isNegative(given)) throw new ValidationError("GST can't be negative.");
    const whole = input.total !== null ? dec(input.total) : amount;
    if (cmp(given, whole) > 0) throw new ValidationError(`The GST (${money(given)}) is more than the ${noun} itself.`);
    gst = input.total !== null ? mulDiv(amount, given, dec(input.total), 2) : given;
  } else if (input.taxCode) {
    const rate = dec(input.taxCode.rate);
    gst = input.taxCode.category === "standard" ? mulDiv(amount, rate, add(dec("1"), rate), 2) : ZERO_DECIMAL;
  }
  if (gst === null) return { gst: null, lines: [{ amount: money(amount), gst: "0.00", taxCode: null, rate: "0", part: null }] };

  const code = input.taxCode;
  if (isZero(gst)) {
    if (code?.category === "standard") throw new ValidationError(`The GST code is ${code.code} (standard-rated) but the GST is 0.00.`);
    return { gst: "0.00", lines: [{ amount: money(amount), gst: "0.00", taxCode: code?.code ?? null, rate: "0", part: null }] };
  }
  if (code && code.category !== "standard") {
    throw new ValidationError(`The GST is ${money(gst)} but the GST code ${code.code} has no GST.`);
  }
  const standard = code ?? input.standard;
  if (!standard) throw new ValidationError("There's no standard-rated GST code to put this GST under. Add one in the GST codes first.");
  const rate = dec(standard.rate);
  const onePlusRate = add(dec("1"), rate);
  const expected = mulDiv(amount, rate, onePlusRate, 2);
  const gap = sub(gst, expected);
  if (cmp(abs(gap), dec(GST_ROUNDING_ALLOWANCE)) <= 0) {
    return { gst: money(gst), lines: [{ amount: money(amount), gst: money(gst), taxCode: standard.code, rate: standard.rate, part: null }] };
  }
  if (isPositive(gap)) {
    throw new ValidationError(
      `The GST (${money(gst)}) is more than GST at ${toPlainString(mul(rate, dec("100")))}% on what's owed would be (${money(expected)}).`,
    );
  }
  // Less GST than a fully standard-rated document: the standard-rated part is the GST x (1 + rate) / rate, the rest has no GST.
  const standardPart = mulDiv(gst, onePlusRate, rate, 2);
  const rest = sub(amount, standardPart);
  return {
    gst: money(gst),
    lines: [
      { amount: money(standardPart), gst: money(gst), taxCode: standard.code, rate: standard.rate, part: "standard" },
      { amount: money(rest), gst: "0.00", taxCode: null, rate: "0", part: "rest" },
    ],
  };
}

/** An opening document's header amounts from its lines: inclusive when any line has a GST code, otherwise no GST. */
export function openingAmounts(amount: string, lines: readonly OpeningLine[]): { amountsMode: "inclusive" | "no_tax"; subtotal: string; taxTotal: string } {
  const lineTotal = lines.reduce((total, line) => add(total, dec(line.amount)), ZERO_DECIMAL);
  if (lines.length === 0 || cmp(lineTotal, dec(amount)) !== 0) {
    throw new ValidationError(`An opening document's lines add up to ${money(lineTotal)}, not ${money(dec(amount))}.`);
  }
  const taxTotal = lines.reduce((total, line) => add(total, dec(line.gst)), ZERO_DECIMAL);
  return {
    amountsMode: lines.some((line) => line.taxCode !== null) ? "inclusive" : "no_tax",
    subtotal: money(sub(dec(amount), taxTotal)),
    taxTotal: money(taxTotal),
  };
}

/** "Owed at 2026-03-31 (opening balance)", with which part it is when the GST split it in two. */
export function openingLineDescription(conversionDate: string, line: OpeningLine): string {
  const base = `Owed at ${conversionDate} (opening balance)`;
  return line.part === "standard" ? `${base}, with GST` : line.part === "rest" ? `${base}, no GST` : base;
}
