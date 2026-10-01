import { ValidationError } from "@/lib/errors";
import { addDays, monthEndOf } from "@/lib/financial-year";
import { add, cmp, dec, type Decimal, divide, isNegative, isPositive, mul, roundHalfUp, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  calculateEsct,
  calculateExtraPayTax,
  calculatePaye,
  calculateStudentLoan,
  kiwiSaverEmployeeContribution,
  kiwiSaverEmployerContribution,
} from "./calculations";
import type { PayFrequency } from "./groups";
import { NOT_SUPPORTED } from "./rates";

/**
 * One employee's pay in a pay run (examples PRUN1-PRUN4, PRUN8), on top of
 * IRD's calculations (calculations.ts) with the rates for the pay date
 * (decision 1). Pure: no database, no network.
 *
 * Taxable earnings are subject to PAYE (which includes the ACC earners'
 * levy) and the student loan deduction; KiwiSaver is on the earnings that
 * count for it (spec 4.5.1); non-taxable earnings (reimbursements,
 * non-taxable allowances) are paid with the wages but not taxed (spec 5.7).
 */

export const KIWI_SAVER_STATUSES = ["enrolled", "not_enrolled", "opted_out", "savings_suspension", "not_eligible"] as const;
export type KiwiSaverStatus = (typeof KIWI_SAVER_STATUSES)[number];

const CALCULATION_FREQUENCY: Record<PayFrequency, string> = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  four_weekly: "four-weekly",
  monthly: "monthly",
};

/** A pay group's frequency as IRD's calculations name it ("four_weekly" → "four-weekly"). */
export function calculationFrequency(frequency: PayFrequency): string {
  return CALCULATION_FREQUENCY[frequency];
}

const PERIODS_PER_YEAR: Record<PayFrequency, string> = { weekly: "52", fortnightly: "26", four_weekly: "13", monthly: "12" };
const PERIOD_DAYS: Partial<Record<PayFrequency, number>> = { weekly: 7, fortnightly: 14, four_weekly: 28 };
const WEEKS_PER_PERIOD: Partial<Record<PayFrequency, string>> = { weekly: "1", fortnightly: "2", four_weekly: "4" };

/** Tax codes with no student loan part (flat rates). */
const FLAT_CODES = new Set(["ND", "NSW", "CAE", "EDW"]);

const money = (value: Decimal) => toFixedString(value, 2);

/** The last day of a pay period that starts on `start` (PRUN11). Monthly periods are calendar months. */
export function payPeriodEnd(start: string, frequency: PayFrequency): string {
  const days = PERIOD_DAYS[frequency];
  if (days) return addDays(start, days - 1);
  if (!start.endsWith("-01")) {
    throw new ValidationError(`${NOT_SUPPORTED}: a monthly pay period that doesn't start on the 1st of a month.`);
  }
  return monthEndOf(start);
}

/** A salary for one pay period: annual / 52, 26, 13 or 12, rounded half up to the cent (PRUN11). */
export function salaryForPeriod(annualSalary: string, frequency: PayFrequency): string {
  return money(divide(dec(annualSalary), dec(PERIODS_PER_YEAR[frequency]), 2));
}

/** Ordinary hours for a period: weekly hours x 1, 2 or 4 weeks; a monthly period starts at 0 (PRUN11). */
export function ordinaryHoursForPeriod(hoursPerWeek: string, frequency: PayFrequency): string {
  const weeks = WEEKS_PER_PERIOD[frequency];
  return toFixedString(weeks ? mul(dec(hoursPerWeek), dec(weeks)) : ZERO_DECIMAL, 2);
}

/** Hours x rate, rounded half up to the cent once (PRUN2: 3.3 x 33.75 = 111.375 → 111.38). */
export function lineAmount(quantity: string, rate: string): string {
  return money(roundHalfUp(mul(dec(quantity), dec(rate)), 2));
}

export type PayLineInput = {
  category: "earnings" | "deduction";
  /** Subject to PAYE, the ACC earners' levy and student loan. */
  taxable: boolean;
  /** Counts as gross salary or wages for KiwiSaver (spec 4.5.1). */
  kiwiSaver: boolean;
  /** Taxed under IRD's extra pay rules (spec 5.11, 5.12; decision 125). */
  extraPay?: boolean;
  /** Liable for the ACC earners' levy; only redundancy isn't (spec 5.11.1 step 4.1). Defaults to taxable. */
  accLevy?: boolean;
  amount: string;
};

export type EmployeePayInput = {
  /** For messages, e.g. "Hemi Walker". */
  name: string;
  frequency: PayFrequency;
  payDate: string;
  taxCode: string;
  studentLoan: boolean;
  kiwiSaverStatus: KiwiSaverStatus;
  kiwiSaverEmployeeRate: string;
  kiwiSaverEmployerRate: string;
  esctRate: string | null;
  lines: readonly PayLineInput[];
  /**
   * The annualised income the extra pays are taxed against (annualiseForExtraPay,
   * decisions 126 and 130); needed only when a line is an extra pay.
   */
  extraPayAnnualised?: string | null;
};

export type EmployeePayResult = {
  /** Every earning, taxable or not. */
  gross: string;
  taxableEarnings: string;
  nonTaxableEarnings: string;
  kiwiSaverEarnings: string;
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  deductions: string;
  netPay: string;
  /** The employer's gross KiwiSaver contribution, before ESCT. */
  kiwiSaverEmployer: string;
  esct: string;
  kiwiSaverEmployerNet: string;
  /** Gross plus the employer's gross KiwiSaver contribution. */
  employerCost: string;
  /** Taxable extra pays in the pay (spec 5.11; decision 125). */
  extraPay: string;
  /** The part of PAYE that is the extra pays' tax, levy included. */
  extraPayTax: string;
  /** The extra pays' income tax rate (percent), or null without extra pays. */
  extraPayTaxRate: string | null;
  /** EI field 14: an extra pay taxed at the lowest rate (spec 5.11.3; decision 129). */
  lumpSumLowestRate: boolean;
};

function sumOf(lines: readonly PayLineInput[], keep: (line: PayLineInput) => boolean): Decimal {
  return lines.filter(keep).reduce((total, line) => {
    const amount = dec(line.amount);
    if (isNegative(amount)) {
      throw new ValidationError(`${NOT_SUPPORTED}: amounts below zero (corrections and back pay).`);
    }
    return add(total, amount);
  }, ZERO_DECIMAL);
}

/**
 * Calculates one employee's pay. Throws a ValidationError with what's wrong
 * (PRUN8): an unsupported tax code, a student loan that disagrees with the
 * tax code, a KiwiSaver rate IRD doesn't allow on the pay date (PRUN4), an
 * employer contribution with no ESCT rate, or net pay below zero.
 */
export function calculateEmployeePay(input: EmployeePayInput): EmployeePayResult {
  const frequency = CALCULATION_FREQUENCY[input.frequency];
  const taxCode = input.taxCode.trim().replace(/\s+/g, " ").toUpperCase();
  const codeHasStudentLoan = taxCode.endsWith(" SL");
  if (!FLAT_CODES.has(taxCode) && input.studentLoan !== codeHasStudentLoan) {
    throw new ValidationError(
      input.studentLoan
        ? `${input.name} has a student loan but tax code ${taxCode} has no SL. Fix their tax code or student loan under Employees.`
        : `${input.name}'s tax code ${taxCode} has SL but they don't have a student loan ticked. Fix their tax code or student loan under Employees.`,
    );
  }

  const taxable = sumOf(input.lines, (line) => line.category === "earnings" && line.taxable);
  const extraPay = sumOf(input.lines, (line) => line.category === "earnings" && line.taxable && line.extraPay === true);
  const extraPayAccLiable = sumOf(
    input.lines,
    (line) => line.category === "earnings" && line.taxable && line.extraPay === true && line.accLevy !== false,
  );
  const nonTaxable = sumOf(input.lines, (line) => line.category === "earnings" && !line.taxable);
  const kiwiSaverEarnings = sumOf(input.lines, (line) => line.category === "earnings" && line.kiwiSaver);
  const deductions = sumOf(input.lines, (line) => line.category === "deduction");
  const gross = add(taxable, nonTaxable);

  // The ordinary pay is taxed as before and the extra pays under IRD's extra pay rules; student loan is on the
  // pay for the period, extra pays included (spec 5.11.1 step 2; decision 132).
  const regular = { gross: money(sub(taxable, extraPay)), frequency, taxCode, payDate: input.payDate };
  let extra: ReturnType<typeof calculateExtraPayTax> | null = null;
  if (isPositive(extraPay)) {
    if (input.extraPayAnnualised === undefined || input.extraPayAnnualised === null) {
      throw new Error(`${input.name}'s extra pay has no annualised income to be taxed against.`);
    }
    extra = calculateExtraPayTax({
      extraPay: money(extraPay),
      accLiable: money(extraPayAccLiable),
      annualised: input.extraPayAnnualised,
      taxCode,
      payDate: input.payDate,
    });
  }
  const paye = money(add(dec(calculatePaye(regular)), dec(extra?.tax ?? "0")));
  const studentLoan = calculateStudentLoan({ ...regular, gross: money(taxable) });

  let kiwiSaverEmployee = "0.00";
  let kiwiSaverEmployer = "0.00";
  let esct = "0.00";
  let kiwiSaverEmployerNet = "0.00";
  if (input.kiwiSaverStatus === "enrolled") {
    const contribution = { gross: money(kiwiSaverEarnings), payDate: input.payDate };
    kiwiSaverEmployee = kiwiSaverEmployeeContribution({ ...contribution, rate: input.kiwiSaverEmployeeRate });
    kiwiSaverEmployer = kiwiSaverEmployerContribution({ ...contribution, rate: input.kiwiSaverEmployerRate });
    if (cmp(dec(kiwiSaverEmployer), ZERO_DECIMAL) > 0) {
      if (!input.esctRate) {
        throw new ValidationError(`${input.name} has employer KiwiSaver contributions but no ESCT rate. Set it under Employees.`);
      }
      const result = calculateEsct({ employerContribution: kiwiSaverEmployer, esctRate: input.esctRate, payDate: input.payDate });
      esct = result.esct;
      kiwiSaverEmployerNet = result.netContribution;
    }
  }

  const netPay = sub(sub(sub(sub(gross, dec(paye)), dec(studentLoan)), dec(kiwiSaverEmployee)), deductions);
  if (isNegative(netPay)) {
    throw new ValidationError(`${NOT_SUPPORTED}: ${input.name}'s net pay would be below zero (${money(netPay)}).`);
  }
  return {
    gross: money(gross),
    taxableEarnings: money(taxable),
    nonTaxableEarnings: money(nonTaxable),
    kiwiSaverEarnings: money(kiwiSaverEarnings),
    paye,
    studentLoan,
    kiwiSaverEmployee,
    deductions: money(deductions),
    netPay: money(netPay),
    kiwiSaverEmployer,
    esct,
    kiwiSaverEmployerNet,
    employerCost: money(add(gross, dec(kiwiSaverEmployer))),
    extraPay: money(extraPay),
    extraPayTax: extra?.tax ?? "0.00",
    extraPayTaxRate: extra?.taxRate ?? null,
    lumpSumLowestRate: extra?.lowestRate ?? false,
  };
}
