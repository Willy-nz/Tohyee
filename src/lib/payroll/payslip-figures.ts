import { add, dec, toFixedString } from "@/lib/money/decimal";

/**
 * The money on a payslip and its year to date (examples PSLIP1, PSLIP2).
 * Browser-safe: the payslip page and the PDF use the same figures.
 */

export type PayslipFigures = {
  gross: string;
  /** Including the ACC earners' levy. */
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  /** After-tax deductions other than KiwiSaver and student loan. */
  deductions: string;
  netPay: string;
  /** Gross employer KiwiSaver contribution (before ESCT). */
  kiwiSaverEmployer: string;
  esct: string;
};

export const PAYSLIP_FIGURE_KEYS = ["gross", "paye", "studentLoan", "kiwiSaverEmployee", "deductions", "netPay", "kiwiSaverEmployer", "esct"] as const;

export const PAYSLIP_ZERO: PayslipFigures = {
  gross: "0.00",
  paye: "0.00",
  studentLoan: "0.00",
  kiwiSaverEmployee: "0.00",
  deductions: "0.00",
  netPay: "0.00",
  kiwiSaverEmployer: "0.00",
  esct: "0.00",
};

export function addPayslipFigures(left: PayslipFigures, right: PayslipFigures): PayslipFigures {
  const result = { ...PAYSLIP_ZERO };
  for (const key of PAYSLIP_FIGURE_KEYS) result[key] = toFixedString(add(dec(left[key]), dec(right[key])), 2);
  return result;
}

/** The NZ tax year a pay date is in: 1 April to 31 March (PSLIP2). */
export function taxYearOf(payDate: string): { start: string; end: string } {
  const year = Number(payDate.slice(0, 4));
  const startYear = payDate.slice(5) >= "04-01" ? year : year - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}
