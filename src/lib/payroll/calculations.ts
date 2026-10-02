import { ValidationError } from "@/lib/errors";
import {
  add,
  cmp,
  dec,
  type Decimal,
  divideTruncated,
  isNegative,
  isZero,
  mul,
  significantScale,
  sub,
  toFixedString,
  toPlainString,
  truncate,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";
import {
  FLAT_RATE_TAX_CODES,
  type FlatRateTaxCode,
  NOT_SUPPORTED,
  PAY_FREQUENCIES,
  type PayFrequency,
  type PayrollRates,
  payrollRatesOn,
  SECONDARY_TAX_CODES,
  type SecondaryTaxCode,
} from "./rates";

/**
 * IRD's payroll calculations for one pay (examples PR1-PR16), following the
 * "Payroll Calculations & Business Rules Specification" for the pay date's
 * tax year (rates/README.md). Pure: no database, no network. Browser-safe.
 *
 * Amounts in and out are dollar strings with at most 2 decimal places. IRD's
 * rules truncate (drop digits) rather than round, at the points the
 * specification says.
 */

export const MAIN_TAX_CODES = ["M", "ME", "M SL", "ME SL"] as const;

/** The tax codes Tohyee calculates, as IRD writes them. */
export const TAX_CODES = [
  ...MAIN_TAX_CODES,
  ...SECONDARY_TAX_CODES,
  ...SECONDARY_TAX_CODES.map((code) => `${code} SL` as const),
  ...FLAT_RATE_TAX_CODES,
] as const;
export type TaxCode = (typeof TAX_CODES)[number];

/** IRD tax codes Tohyee refuses for now, and why. */
const REFUSED_TAX_CODES: Record<string, string> = {
  STC: "tailored tax codes (STC) need the rate on the employee's IR23 certificate",
  WT: "schedular payments (WT) aren't salary or wages",
};

const PERIODS_PER_YEAR: Record<PayFrequency, string> = {
  weekly: "52",
  fortnightly: "26",
  "four-weekly": "13",
  monthly: "12",
};

const HUNDRED = dec("100");
const ONE_PERCENT = dec("0.01");

type ParsedTaxCode =
  | { kind: "main"; independentEarner: boolean; studentLoan: boolean }
  | { kind: "secondary"; code: SecondaryTaxCode; studentLoan: boolean }
  | { kind: "flat"; code: FlatRateTaxCode };

export type PayInput = {
  /** Gross pay for the pay period, e.g. "3500.00". */
  gross: string;
  frequency: string;
  taxCode: string;
  /** YYYY-MM-DD. */
  payDate: string;
};

function percent(rate: string): Decimal {
  return mul(dec(rate), ONE_PERCENT);
}

function money(value: Decimal): string {
  return toFixedString(truncate(value, 2), 2);
}

function parseAmount(input: unknown, label: string): Decimal {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ValidationError(`${label} is required.`);
  }
  const value = dec(input);
  if (isNegative(value)) {
    throw new ValidationError(`${NOT_SUPPORTED}: ${label} below zero.`);
  }
  if (significantScale(value) > 2) {
    throw new ValidationError(`${label} can't have more than 2 decimal places.`);
  }
  return value;
}

function parseFrequency(input: unknown): PayFrequency {
  if (typeof input === "string" && (PAY_FREQUENCIES as readonly string[]).includes(input)) {
    return input as PayFrequency;
  }
  throw new ValidationError(
    `${NOT_SUPPORTED}: pay frequency "${String(input)}". Tohyee calculates ${PAY_FREQUENCIES.join(", ")} pays.`,
  );
}

function parseTaxCode(input: unknown): ParsedTaxCode {
  const code = typeof input === "string" ? input.trim().replace(/\s+/g, " ").toUpperCase() : "";
  if (code in REFUSED_TAX_CODES) {
    throw new ValidationError(`${NOT_SUPPORTED}: ${REFUSED_TAX_CODES[code]}.`);
  }
  if (!(TAX_CODES as readonly string[]).includes(code)) {
    throw new ValidationError(`"${String(input)}" isn't an IRD tax code Tohyee knows.`);
  }
  const studentLoan = code.endsWith(" SL");
  const base = studentLoan ? code.slice(0, -3) : code;
  if (base === "M" || base === "ME") {
    return { kind: "main", independentEarner: base === "ME", studentLoan };
  }
  if ((SECONDARY_TAX_CODES as readonly string[]).includes(base)) {
    return { kind: "secondary", code: base as SecondaryTaxCode, studentLoan };
  }
  return { kind: "flat", code: base as FlatRateTaxCode };
}

function parseWholeDollars(input: unknown, label: string): Decimal {
  const value = parseAmount(input, label);
  if (significantScale(value) > 0) {
    throw new ValidationError(`${label} must be whole dollars.`);
  }
  return value;
}

/** Annual income tax (specification 5.2 step 3), not rounded. */
function incomeTaxFor(annualIncome: Decimal, rates: PayrollRates): Decimal {
  const bracket = rates.incomeTax.find(
    (entry) =>
      cmp(annualIncome, dec(entry.from)) >= 0 && (entry.to === null || cmp(annualIncome, dec(entry.to)) <= 0),
  );
  if (!bracket) {
    throw new Error(`IRD payroll rates ${rates.edition.id} have no income tax bracket for ${toPlainString(annualIncome)}.`);
  }
  return sub(mul(annualIncome, percent(bracket.rate)), dec(bracket.subtract));
}

/** Annual ACC earners' levy (specification 5.2 step 4), not rounded. */
function accEarnersLevyFor(annualIncome: Decimal, rates: PayrollRates): Decimal {
  const levy = rates.accEarnersLevy;
  if (cmp(annualIncome, dec(levy.maximumLiableEarnings)) < 0) {
    return mul(annualIncome, percent(levy.rate));
  }
  return dec(levy.maximumLevy);
}

/** Independent earner tax credit (specification 5.3 step 4), not rounded. */
function independentEarnerTaxCreditFor(annualIncome: Decimal, rates: PayrollRates): Decimal {
  const credit = rates.independentEarnerTaxCredit;
  if (cmp(annualIncome, dec(credit.lowerThreshold)) < 0 || cmp(annualIncome, dec(credit.upperThreshold)) >= 0) {
    return ZERO_DECIMAL;
  }
  const abatementStarts = dec(credit.abatementStarts);
  if (cmp(annualIncome, abatementStarts) <= 0) {
    return dec(credit.amount);
  }
  return sub(dec(credit.amount), mul(sub(annualIncome, abatementStarts), percent(credit.abatementRate)));
}

/** M, ME, M SL and ME SL (specification 5.2 and 5.3). */
function annualisedPaye(gross: Decimal, frequency: PayFrequency, independentEarner: boolean, rates: PayrollRates) {
  const periods = dec(PERIODS_PER_YEAR[frequency]);
  const annualIncome = truncate(mul(gross, periods), 0);
  let annualTotal = add(incomeTaxFor(annualIncome, rates), accEarnersLevyFor(annualIncome, rates));
  if (independentEarner) {
    annualTotal = sub(annualTotal, independentEarnerTaxCreditFor(annualIncome, rates));
  }
  const weekly = divideTruncated(annualTotal, dec("52"), 2);
  if (frequency === "weekly") {
    return weekly;
  }
  return divideTruncated(mul(weekly, dec("52")), periods, 2);
}

/** Secondary codes, ND, NSW, CAE and EDW: a flat rate plus the levy on whole dollars (5.5-5.8). */
function flatRatePaye(gross: Decimal, taxRate: string, rates: PayrollRates): Decimal {
  const rate = add(percent(taxRate), percent(rates.accEarnersLevy.rate));
  return truncate(mul(truncate(gross, 0), rate), 2);
}

/**
 * PAYE for one pay, including the ACC earners' levy as IRD's PAYE does,
 * with the rates in effect on the pay date. Extra pays (bonuses, lump sums,
 * holiday pay on leaving) are a later stage.
 */
export function calculatePaye(input: PayInput): string {
  const rates = payrollRatesOn(input.payDate);
  const gross = parseAmount(input.gross, "Gross pay");
  const frequency = parseFrequency(input.frequency);
  const code = parseTaxCode(input.taxCode);
  switch (code.kind) {
    case "main":
      return money(annualisedPaye(gross, frequency, code.independentEarner, rates));
    case "secondary":
      return money(flatRatePaye(gross, rates.secondaryTaxRates[code.code], rates));
    case "flat":
      return money(flatRatePaye(gross, rates.flatTaxRates[code.code], rates));
  }
}

/**
 * The annual ACC earners' levy on an annual income in whole dollars
 * (specification 5.2 step 4), not rounded, as IRD's PAYE calculation uses
 * it. IRD's rules don't split a pay's PAYE into tax and levy.
 */
export function annualAccEarnersLevy(input: { annualIncome: string; payDate: string }): string {
  const rates = payrollRatesOn(input.payDate);
  return toPlainString(accEarnersLevyFor(parseWholeDollars(input.annualIncome, "Annual income"), rates));
}

/**
 * The student loan deduction for one pay (specification 5.4 and 5.6): "0.00"
 * unless the tax code ends in SL. Special deduction rates (SDR), Commissioner
 * (SLCIR) and voluntary (SLBOR) deductions aren't supported yet.
 */
export function calculateStudentLoan(input: PayInput): string {
  const rates = payrollRatesOn(input.payDate);
  const gross = parseAmount(input.gross, "Gross pay");
  const frequency = parseFrequency(input.frequency);
  const code = parseTaxCode(input.taxCode);
  if (code.kind === "flat" || !code.studentLoan) {
    return "0.00";
  }
  const pay = truncate(gross, 0);
  const rate = percent(rates.studentLoan.rate);
  if (code.kind === "secondary") {
    return money(mul(pay, rate));
  }
  const threshold = dec(rates.studentLoan.payPeriodThresholds[frequency]);
  if (cmp(pay, threshold) <= 0) {
    return "0.00";
  }
  return money(mul(sub(pay, threshold), rate));
}

export type KiwiSaverInput = {
  /** Gross salary or wages for the pay, e.g. "600.00". */
  gross: string;
  /** Contribution rate in percent, e.g. "3.5". */
  rate: string;
  payDate: string;
  /** The employee has an approved temporary rate reduction (from 1 April 2026). */
  temporaryRateReduction?: boolean;
};

function parseRate(input: unknown, label: string): Decimal {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ValidationError(`${label} is required.`);
  }
  const rate = dec(input);
  if (isNegative(rate) || cmp(rate, HUNDRED) > 0) {
    throw new ValidationError(`${label} must be between 0% and 100%.`);
  }
  return rate;
}

function temporaryRateReductionFor(rates: PayrollRates) {
  const reduction = rates.kiwiSaver.temporaryRateReduction;
  if (!reduction) {
    throw new ValidationError(
      `IRD has no KiwiSaver temporary rate reduction for pay dates on ${rates.payDate} (${rates.edition.id}).`,
    );
  }
  return reduction;
}

/** The employee's KiwiSaver deduction: gross x rate, truncated to cents (specification 5.20.2). */
export function kiwiSaverEmployeeContribution(input: KiwiSaverInput): string {
  const rates = payrollRatesOn(input.payDate);
  const gross = parseAmount(input.gross, "Gross pay");
  const rate = parseRate(input.rate, "KiwiSaver employee rate");
  const allowed = input.temporaryRateReduction
    ? [temporaryRateReductionFor(rates).employeeRate]
    : rates.kiwiSaver.employeeRates;
  if (!allowed.some((entry) => cmp(dec(entry), rate) === 0)) {
    throw new ValidationError(
      `${toPlainString(rate)}% isn't a KiwiSaver employee rate on ${rates.payDate}${
        input.temporaryRateReduction ? " with a temporary rate reduction" : ""
      }: use ${allowed.map((entry) => `${entry}%`).join(", ")}.`,
    );
  }
  return money(mul(gross, percent(input.rate)));
}

/**
 * The employer's gross KiwiSaver contribution (before ESCT): gross x rate,
 * truncated to cents. The rate can't be below the compulsory minimum on the
 * pay date (or the temporary rate reduction's, if the employee has one).
 */
export function kiwiSaverEmployerContribution(input: KiwiSaverInput): string {
  const rates = payrollRatesOn(input.payDate);
  const gross = parseAmount(input.gross, "Gross pay");
  const rate = parseRate(input.rate, "KiwiSaver employer rate");
  const minimum = input.temporaryRateReduction
    ? temporaryRateReductionFor(rates).employerRate
    : rates.kiwiSaver.minimumEmployerRate;
  if (cmp(rate, dec(minimum)) < 0) {
    throw new ValidationError(
      `The compulsory KiwiSaver employer contribution on ${rates.payDate} is at least ${minimum}%${
        input.temporaryRateReduction ? " with a temporary rate reduction" : ""
      }.`,
    );
  }
  return money(mul(gross, percent(input.rate)));
}

/**
 * The ESCT rate (percent) for an employee's ESCT rate threshold amount: last
 * year's salary or wages plus the employer's gross superannuation
 * contributions, or the employer's estimate (specification 5.20.4-5.21.2).
 * Amounts between two bands (e.g. 18,720.50) are refused.
 */
export function esctRateFor(input: { thresholdAmount: string; payDate: string }): string {
  const rates = payrollRatesOn(input.payDate);
  const amount = parseAmount(input.thresholdAmount, "ESCT rate threshold amount");
  const band = rates.esct.find(
    (entry) => cmp(amount, dec(entry.from)) >= 0 && (entry.to === null || cmp(amount, dec(entry.to)) <= 0),
  );
  if (!band) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: an ESCT rate threshold amount of ${toPlainString(amount)} is between two of IRD's bands.`,
    );
  }
  return band.rate;
}

/**
 * ESCT on an employer's gross KiwiSaver contribution (specification 5.21.3):
 * the contribution's whole dollars x the ESCT rate, truncated to cents. The
 * net contribution is the contribution (with its cents) less the ESCT.
 */
export function calculateEsct(input: { employerContribution: string; esctRate: string; payDate: string }): {
  esct: string;
  netContribution: string;
} {
  const rates = payrollRatesOn(input.payDate);
  const contribution = parseAmount(input.employerContribution, "Employer contribution");
  const rate = parseRate(input.esctRate, "ESCT rate");
  if (!rates.esct.some((band) => cmp(dec(band.rate), rate) === 0)) {
    throw new ValidationError(
      `${toPlainString(rate)}% isn't an ESCT rate on ${rates.payDate}: use ${rates.esct
        .map((band) => `${band.rate}%`)
        .join(", ")}.`,
    );
  }
  const esct = truncate(mul(truncate(contribution, 0), percent(input.esctRate)), 2);
  return { esct: money(esct), netContribution: money(sub(contribution, esct)) };
}

// Extra pays (payroll stage P12; examples XP1-XP7; decisions 126-131)

/** How an extra pay's income is annualised: the four weeks to its pay date (spec 5.11.1) or the last 2 paid periods on leaving (5.12). */
export type ExtraPayMethod = "four_weeks" | "end_of_employment";

/** Pays in four weeks that IRD's rules annualise (spec 5.11.1 step 3.1), and by what. */
const FOUR_WEEK_PAYS: Record<PayFrequency, { count: number; multiplier: string }> = {
  weekly: { count: 4, multiplier: "13" },
  fortnightly: { count: 2, multiplier: "13" },
  "four-weekly": { count: 1, multiplier: "13" },
  monthly: { count: 1, multiplier: "12" },
};

/** The last 2 paid periods' multipliers on leaving (spec 5.12; IR335 page 40). */
const END_OF_EMPLOYMENT_MULTIPLIER: Record<PayFrequency, string> = {
  weekly: "26",
  fortnightly: "13",
  "four-weekly": "6.5",
  monthly: "6",
};

const FREQUENCY_WORDS: Record<PayFrequency, string> = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  "four-weekly": "four-weekly",
  monthly: "monthly",
};

function pays(count: number, frequency: PayFrequency): string {
  return `${count} ${FREQUENCY_WORDS[frequency]} pay${count === 1 ? "" : "s"}`;
}

/** A figure with at least 2 decimal places and no trailing zeros past them. */
function atLeastCents(value: Decimal): string {
  return toFixedString(value, Math.max(2, significantScale(value)));
}

/**
 * The annualised income an extra pay is taxed against (decisions 126, 130):
 * the regular PAYE income payments (extra pays left out) × 13, or × 12 for
 * one monthly pay, when the four weeks hold IRD's pattern of pays (none
 * gives $0, spec example 3); on leaving, the last 2 paid periods × 26, 13,
 * 6.5 or 6. Any other pattern is refused. Not rounded (spec 3.2 drops cents
 * only from the grossed-up amount).
 */
export function annualiseForExtraPay(input: { method: ExtraPayMethod; frequency: string; pays: readonly string[] }): string {
  const frequency = parseFrequency(input.frequency);
  const amounts = input.pays.map((pay, index) => parseAmount(pay, `Pay ${index + 1}`));
  const total = amounts.reduce((sumSoFar, amount) => add(sumSoFar, amount), ZERO_DECIMAL);
  if (input.method === "four_weeks") {
    if (amounts.length === 0) return "0.00";
    const expected = FOUR_WEEK_PAYS[frequency];
    if (amounts.length === expected.count) return atLeastCents(mul(total, dec(expected.multiplier)));
    // Spec 2026-27 5.11.1 note 4: with only one pay period paid before the extra pay, "the amount paid for that pay
    // period is the amount to be annualised", but not how (by its frequency or x 13), so that stays refused (decision 213).
    if (amounts.length === 1) {
      throw new ValidationError(
        `${NOT_SUPPORTED}: an extra pay when the four weeks before it hold ${pays(1, frequency)} (IRD's note 4 doesn't say how one pay is annualised).`,
      );
    }
    // Step 3.1: "In other circumstances, add all PAYE income payments made to the employee in the four weeks prior and
    // multiply by 13" (decision 213; XP15).
    return atLeastCents(mul(total, dec("13")));
  }
  if (amounts.length !== 2) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: an extra pay on leaving with ${amounts.length} paid pay period${amounts.length === 1 ? "" : "s"} before the final pay (IRD's rule annualises the last 2).`,
    );
  }
  return atLeastCents(mul(total, dec(END_OF_EMPLOYMENT_MULTIPLIER[frequency])));
}

/**
 * A secondary tax code's low threshold amount (spec 5.11.2): the start of
 * the income tax bracket taxed at the code's rate (SB $0, S $15,601, SH
 * $53,501, ST $78,101, SA $180,001 in 2026-27).
 */
export function secondaryLowThreshold(code: SecondaryTaxCode, payDate: string): string {
  const rates = payrollRatesOn(payDate);
  const rate = dec(rates.secondaryTaxRates[code]);
  const bracket = rates.incomeTax.find((entry) => cmp(dec(entry.rate), rate) === 0);
  if (!bracket) throw new Error(`IRD payroll rates ${rates.edition.id} have no income tax bracket at ${code}'s rate.`);
  return bracket.from;
}

export type ExtraPayTaxInput = {
  /** All the extra pays in the pay, e.g. "1000.00". */
  extraPay: string;
  /** The part liable for the ACC earners' levy (all but redundancy). */
  accLiable: string;
  /** From annualiseForExtraPay. */
  annualised: string;
  taxCode: string;
  payDate: string;
};

export type ExtraPayTaxResult = {
  /** Tax on the extra pays, the ACC earners' levy included. */
  tax: string;
  /** The income tax rate used (percent, without the levy). */
  taxRate: string;
  /** Whole dollars; null for a flat rate. */
  grossedUp: string | null;
  /** The lowest rate was used: EI field 14 (spec 5.11.3). */
  lowestRate: boolean;
  method: "extra_pay" | "flat_rate";
};

/**
 * Tax on an employee's extra pays in one pay (spec 5.11.1 steps 3-5,
 * 5.11.2, 5.12): the grossed-up amount (annualised income, plus a
 * secondary code's low threshold, plus the extra pays) with its cents
 * dropped picks the rate; extra pays × rate and the levy (steps 4.1-4.4)
 * are added unrounded and truncated to cents once (decision 127). ND and
 * NSW use their flat rate (decision 128); CAE, EDW and STC are refused.
 */
export function calculateExtraPayTax(input: ExtraPayTaxInput): ExtraPayTaxResult {
  const rates = payrollRatesOn(input.payDate);
  const extraPay = parseAmount(input.extraPay, "Extra pay");
  const accLiable = parseAmount(input.accLiable, "Extra pay liable for the ACC earners' levy");
  if (cmp(accLiable, extraPay) > 0) {
    throw new ValidationError("The extra pay liable for the ACC earners' levy can't be more than the extra pay.");
  }
  const annualisedInput = dec(input.annualised);
  if (isNegative(annualisedInput)) throw new ValidationError("Annualised income can't be below zero.");
  const code = parseTaxCode(input.taxCode);
  const codeText = input.taxCode.trim().replace(/\s+/g, " ").toUpperCase();
  if (code.kind === "flat") {
    if (code.code === "CAE" || code.code === "EDW") {
      throw new ValidationError(
        `${NOT_SUPPORTED}: extra pays for tax code ${code.code} (IRD says to use the lump sum method but not with which threshold).`,
      );
    }
    if (cmp(accLiable, extraPay) !== 0) {
      throw new ValidationError(`${NOT_SUPPORTED}: redundancy for tax code ${code.code} (its flat rate includes the ACC earners' levy).`);
    }
    return {
      tax: money(flatRatePaye(extraPay, rates.flatTaxRates[code.code], rates)),
      taxRate: rates.flatTaxRates[code.code],
      grossedUp: null,
      lowestRate: false,
      method: "flat_rate",
    };
  }
  const threshold = code.kind === "secondary" ? dec(secondaryLowThreshold(code.code, input.payDate)) : ZERO_DECIMAL;
  const annualised = add(annualisedInput, threshold);
  const grossedUp = truncate(add(annualised, extraPay), 0);
  const bracket = rates.incomeTax.find(
    (entry) => cmp(grossedUp, dec(entry.from)) >= 0 && (entry.to === null || cmp(grossedUp, dec(entry.to)) <= 0),
  );
  if (!bracket) {
    throw new Error(`IRD payroll rates ${rates.edition.id} have no income tax bracket for ${toPlainString(grossedUp)} (${codeText}).`);
  }
  const incomeTax = mul(extraPay, percent(bracket.rate));
  const maximum = dec(rates.accEarnersLevy.maximumLiableEarnings);
  const levyRate = percent(rates.accEarnersLevy.rate);
  let levy: Decimal;
  if (isZero(accLiable)) {
    levy = ZERO_DECIMAL; // step 4.1: redundancy
  } else if (cmp(grossedUp, maximum) <= 0) {
    levy = mul(accLiable, levyRate); // step 4.2
  } else if (cmp(annualised, maximum) <= 0) {
    if (cmp(accLiable, extraPay) !== 0) {
      throw new ValidationError(`${NOT_SUPPORTED}: redundancy with other extra pays when the ACC earners' levy's maximum falls inside them.`);
    }
    levy = mul(sub(maximum, annualised), levyRate); // step 4.3
  } else {
    levy = ZERO_DECIMAL; // step 4.4
  }
  return {
    tax: money(add(incomeTax, levy)),
    taxRate: bracket.rate,
    grossedUp: toPlainString(grossedUp),
    lowestRate: cmp(dec(bracket.rate), dec(rates.incomeTax[0].rate)) === 0,
    method: "extra_pay",
  };
}
