import { parseIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { RATES_2025_26 } from "./2025-26";
import { RATES_2026_27 } from "./2026-27";
import type {
  AccEarnersLevy,
  Dated,
  EsctBand,
  FlatRateTaxCode,
  IncomeTaxBracket,
  IndependentEarnerTaxCredit,
  KiwiSaver,
  PayrollRatesEdition,
  SecondaryTaxCode,
  StudentLoan,
} from "./types";

export * from "./types";

/**
 * Every edition Tohyee has, oldest first. Adding a year is adding a file and
 * listing it here (README.md).
 */
export const PAYROLL_RATE_EDITIONS: readonly PayrollRatesEdition[] = [RATES_2025_26, RATES_2026_27];

export const NOT_SUPPORTED = "Not supported yet (refused rather than guessed)";

/** The rates in effect on one pay date, with the edition they came from. */
export type PayrollRates = {
  edition: PayrollRatesEdition;
  payDate: string;
  incomeTax: IncomeTaxBracket[];
  accEarnersLevy: AccEarnersLevy;
  independentEarnerTaxCredit: IndependentEarnerTaxCredit;
  secondaryTaxRates: Record<SecondaryTaxCode, string>;
  flatTaxRates: Record<FlatRateTaxCode, string>;
  studentLoan: StudentLoan;
  kiwiSaver: KiwiSaver;
  esct: EsctBand[];
};

function valueOn<T>(edition: PayrollRatesEdition, name: string, values: Dated<T>[], payDate: string): T {
  const matches = values.filter((entry) => entry.from <= payDate && payDate <= entry.to);
  if (matches.length !== 1) {
    throw new Error(
      `IRD payroll rates ${edition.id} have ${matches.length} values for ${name} on ${payDate}; expected exactly one.`,
    );
  }
  return matches[0].value;
}

function coveredRange(editions: readonly PayrollRatesEdition[]): string {
  const first = editions[0];
  const last = editions[editions.length - 1];
  return `${first.from} to ${last.to}`;
}

/**
 * IRD's rates for a pay date (YYYY-MM-DD). Pay dates no edition covers are
 * refused: Tohyee never carries a year's rates forward. `editions` is for
 * tests.
 */
export function payrollRatesOn(
  payDate: string,
  editions: readonly PayrollRatesEdition[] = PAYROLL_RATE_EDITIONS,
): PayrollRates {
  const date = parseIsoDate(payDate, "Pay date");
  const edition = editions.find((entry) => entry.from <= date && date <= entry.to);
  if (!edition) {
    throw new ValidationError(
      `${NOT_SUPPORTED}: Tohyee has no IRD payroll rates for pay dates on ${date}. It has them for ${coveredRange(editions)}.`,
    );
  }
  return {
    edition,
    payDate: date,
    incomeTax: valueOn(edition, "income tax", edition.incomeTax, date),
    accEarnersLevy: valueOn(edition, "the ACC earners' levy", edition.accEarnersLevy, date),
    independentEarnerTaxCredit: valueOn(
      edition,
      "the independent earner tax credit",
      edition.independentEarnerTaxCredit,
      date,
    ),
    secondaryTaxRates: valueOn(edition, "secondary tax rates", edition.secondaryTaxRates, date),
    flatTaxRates: valueOn(edition, "flat tax rates", edition.flatTaxRates, date),
    studentLoan: valueOn(edition, "student loans", edition.studentLoan, date),
    kiwiSaver: valueOn(edition, "KiwiSaver", edition.kiwiSaver, date),
    esct: valueOn(edition, "ESCT", edition.esct, date),
  };
}
