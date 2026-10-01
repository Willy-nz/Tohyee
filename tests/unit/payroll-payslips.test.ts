import { describe, expect, it } from "vitest";
import { maskBankAccount } from "@/lib/payroll/bank-account-number";
import { addPayslipFigures, PAYSLIP_ZERO, taxYearOf } from "@/lib/payroll/payslip-figures";

/** Examples PSLIP1 and PSLIP2 (docs/ACCOUNTING-EXAMPLES.md, "NZ payroll — payslips", not yet approved by Jess). */

describe("the tax year (PSLIP2)", () => {
  it("runs 1 April to 31 March, by pay date", () => {
    expect(taxYearOf("2026-10-14")).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(taxYearOf("2027-03-31")).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(taxYearOf("2027-04-01")).toEqual({ start: "2027-04-01", end: "2028-03-31" });
    expect(taxYearOf("2026-01-05")).toEqual({ start: "2025-04-01", end: "2026-03-31" });
  });
});

describe("year to date (PSLIP2)", () => {
  it("adds Hemi's two fortnightly pays", () => {
    const pay = {
      gross: "2692.31",
      paye: "555.58",
      studentLoan: "0.00",
      kiwiSaverEmployee: "94.23",
      deductions: "0.00",
      netPay: "2042.50",
      kiwiSaverEmployer: "94.23",
      esct: "28.20",
    };
    expect(addPayslipFigures(addPayslipFigures(PAYSLIP_ZERO, pay), pay)).toEqual({
      gross: "5384.62",
      paye: "1111.16",
      studentLoan: "0.00",
      kiwiSaverEmployee: "188.46",
      deductions: "0.00",
      netPay: "4085.00",
      kiwiSaverEmployer: "188.46",
      esct: "56.40",
    });
  });
});

describe("the bank account on a payslip (PSLIP1)", () => {
  it("shows only the last 3 digits", () => {
    expect(maskBankAccount("01-0242-0123456-00")).toBe("**-****-******6-00");
  });
});
