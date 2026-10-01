/**
 * Shapes of IRD's payroll rates. Each edition of IRD's "Payroll Calculations
 * and Business Rules Specification" has one data file in this folder (see
 * README.md). Browser-safe: no server imports.
 *
 * Amounts are dollar strings and rates are percentages exactly as IRD prints
 * them ("1.75" for 1.75%), so a file can be checked line by line against the
 * PDF. Dates are YYYY-MM-DD and inclusive.
 */

export const PAY_FREQUENCIES = ["weekly", "fortnightly", "four-weekly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const SECONDARY_TAX_CODES = ["SB", "S", "SH", "ST", "SA"] as const;
export type SecondaryTaxCode = (typeof SECONDARY_TAX_CODES)[number];

export const FLAT_RATE_TAX_CODES = ["ND", "NSW", "CAE", "EDW"] as const;
export type FlatRateTaxCode = (typeof FLAT_RATE_TAX_CODES)[number];

/** A published IRD document, as read. */
export type IrdDocument = {
  /** Title as printed, e.g. "Weekly and fortnightly PAYE deduction tables". */
  document: string;
  /** IRD's form number, if it has one (e.g. "IR340"). */
  number?: string;
  /** Edition or version as printed on the cover. */
  edition: string;
  url: string;
  /** The date we downloaded and read it. */
  read: string;
  /** SHA-256 of the PDF we read, so a later reader can tell whether IRD has changed it. */
  sha256: string;
};

/**
 * A value that applies from `from` to `to` (inclusive, by pay date), with
 * where it is in the edition's specification. An edition can list several
 * values for one rate if IRD changes it part way through a year.
 */
export type Dated<T> = {
  from: string;
  to: string;
  /** Section and page in the edition's specification, e.g. "2.6, page 8". */
  source: string;
  value: T;
};

/**
 * One income tax bracket as the specification states it: for annual income
 * from `from` to `to` dollars (inclusive; `to` null for no upper limit), tax
 * is annual income x `rate`% minus `subtract`.
 */
export type IncomeTaxBracket = {
  from: string;
  to: string | null;
  rate: string;
  subtract: string;
};

export type AccEarnersLevy = {
  /** Percent of liable earnings, e.g. "1.75". */
  rate: string;
  /** Annual earnings at or above which the levy is the maximum. */
  maximumLiableEarnings: string;
  maximumLevy: string;
};

export type IndependentEarnerTaxCredit = {
  /** Annual income from which the credit applies. */
  lowerThreshold: string;
  /** Annual income from which there is no credit. */
  upperThreshold: string;
  /** Annual income above which the credit reduces. */
  abatementStarts: string;
  amount: string;
  /** Percent of each dollar above `abatementStarts` the credit reduces by, e.g. "13". */
  abatementRate: string;
};

export type StudentLoan = {
  annualRepaymentThreshold: string;
  /** Percent, e.g. "12". */
  rate: string;
  payPeriodThresholds: Record<PayFrequency, string>;
};

export type KiwiSaver = {
  /** Employee contribution rates an employee can choose (percent). */
  employeeRates: string[];
  defaultEmployeeRate: string;
  /** Minimum compulsory employer contribution (percent). */
  minimumEmployerRate: string;
  /**
   * An employee with an approved temporary rate reduction contributes at this
   * rate, and the employer may contribute at it too. Null if there's none.
   */
  temporaryRateReduction: { employeeRate: string; employerRate: string } | null;
};

/** One ESCT band: ESCT rate threshold amounts from `from` to `to` dollars inclusive. */
export type EsctBand = {
  from: string;
  to: string | null;
  rate: string;
};

export type PayrollRatesEdition = {
  /** The tax year, e.g. "2026-27". */
  id: string;
  /** Pay dates this file covers (inclusive). */
  from: string;
  to: string;
  /** The primary source. */
  specification: IrdDocument;
  /** Other IRD documents the figures and tests were checked against. */
  crossChecks: IrdDocument[];
  incomeTax: Dated<IncomeTaxBracket[]>[];
  accEarnersLevy: Dated<AccEarnersLevy>[];
  independentEarnerTaxCredit: Dated<IndependentEarnerTaxCredit>[];
  /** Tax rate (percent, before the ACC earners' levy) for each secondary tax code. */
  secondaryTaxRates: Dated<Record<SecondaryTaxCode, string>>[];
  /** Flat tax rate (percent, before the ACC earners' levy) for ND, NSW, CAE and EDW. */
  flatTaxRates: Dated<Record<FlatRateTaxCode, string>>[];
  studentLoan: Dated<StudentLoan>[];
  kiwiSaver: Dated<KiwiSaver>[];
  esct: Dated<EsctBand[]>[];
};
