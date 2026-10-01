import { formatDate, formatMoney } from "@/lib/format";
import { isZero, dec } from "@/lib/money/decimal";
import type { Payslip } from "@/lib/payroll/payslips";

/**
 * What a payslip shows, in order and formatted (PSLIP1, PSLIP3), so the
 * page and the PDF show exactly the same. Browser-safe. Lines that are 0.00
 * (student loan, other deductions) are left out of the period's
 * deductions; the year to date shows everything.
 */

export type PayslipRow = { label: string; hours: string; rate: string; amount: string };

export type PayslipLayout = {
  title: string;
  details: Array<[string, string]>;
  earnings: PayslipRow[];
  gross: PayslipRow;
  deductions: Array<[string, string]>;
  netPay: string;
  employer: Array<[string, string]>;
  yearToDateHeading: string;
  yearToDate: Array<[string, string]>;
  notes: string[];
};

function rate(value: string | null): string {
  return value === null ? "" : `${value}%`;
}

export function payslipLayout(payslip: Payslip): PayslipLayout {
  const details: Array<[string, string]> = [
    ["Employer", payslip.employer.name],
    ["Employee", payslip.employee.name],
    ["Started", formatDate(payslip.employee.startDate)],
    ["Pay period", `${formatDate(payslip.periodStart)} to ${formatDate(payslip.periodEnd)} (${payslip.payFrequencyWords})`],
    ["Pay date", formatDate(payslip.payDate)],
    ["Tax code", payslip.taxCode],
    ["Paid into", payslip.bankAccount ?? "No bank account on file"],
  ];
  const earnings = payslip.earnings.map((line) => ({
    label: `${line.name}${line.description ? `: ${line.description}` : ""}${line.notTaxed ? " (not taxed)" : ""}`,
    hours: line.hours ?? "",
    rate: line.rate ? formatMoney(line.rate, Math.max(2, line.rate.split(".")[1]?.length ?? 0)) : "",
    amount: formatMoney(line.amount),
  }));
  const pay = payslip.pay;
  const shown = (value: string) => !isZero(dec(value));
  const deductions: Array<[string, string]> = [["PAYE (incl. ACC earners' levy)", formatMoney(pay.paye)]];
  if (shown(pay.studentLoan)) deductions.push(["Student loan", formatMoney(pay.studentLoan)]);
  if (payslip.kiwiSaverEmployeeRate !== null || shown(pay.kiwiSaverEmployee)) {
    deductions.push([`KiwiSaver employee${payslip.kiwiSaverEmployeeRate ? ` (${rate(payslip.kiwiSaverEmployeeRate)})` : ""}`, formatMoney(pay.kiwiSaverEmployee)]);
  }
  for (const line of payslip.deductions) {
    deductions.push([`${line.name}${line.description ? `: ${line.description}` : ""}`, formatMoney(line.amount)]);
  }
  const employer: Array<[string, string]> = [];
  if (payslip.kiwiSaverEmployerRate !== null || shown(pay.kiwiSaverEmployer)) {
    employer.push([`KiwiSaver employer${payslip.kiwiSaverEmployerRate ? ` (${rate(payslip.kiwiSaverEmployerRate)})` : ""}`, formatMoney(pay.kiwiSaverEmployer)]);
    employer.push(["ESCT (tax on the employer's KiwiSaver)", formatMoney(pay.esct)]);
    employer.push(["Paid to your KiwiSaver", formatMoney(payslip.kiwiSaverEmployerNet)]);
  }
  const ytd = payslip.yearToDate;
  return {
    title: "Payslip",
    details,
    earnings,
    gross: { label: "Gross pay", hours: payslip.totalHours ?? "", rate: "", amount: formatMoney(pay.gross) },
    deductions,
    netPay: formatMoney(pay.netPay),
    employer,
    yearToDateHeading: `Year to date (${formatDate(payslip.taxYear.start)} to ${formatDate(payslip.taxYear.end)})`,
    yearToDate: [
      ["Gross pay", formatMoney(ytd.gross)],
      ["PAYE (incl. ACC earners' levy)", formatMoney(ytd.paye)],
      ["Student loan", formatMoney(ytd.studentLoan)],
      ["KiwiSaver employee", formatMoney(ytd.kiwiSaverEmployee)],
      ["Other deductions", formatMoney(ytd.deductions)],
      ["Net pay", formatMoney(ytd.netPay)],
      ["KiwiSaver employer", formatMoney(ytd.kiwiSaverEmployer)],
      ["ESCT", formatMoney(ytd.esct)],
    ],
    notes: [`Pay run ${payslip.payRunReference}.`],
  };
}
