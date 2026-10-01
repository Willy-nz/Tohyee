import { describe, expect, it } from "vitest";
import {
  calculateEmployeePay,
  type EmployeePayInput,
  lineAmount,
  ordinaryHoursForPeriod,
  payPeriodEnd,
  salaryForPeriod,
} from "@/lib/payroll/pay-calculation";

const REFUSED = "Not supported yet (refused rather than guessed)";

const earnings = (amount: string, taxable = true, kiwiSaver = taxable) => ({ category: "earnings" as const, taxable, kiwiSaver, amount });
const deduction = (amount: string) => ({ category: "deduction" as const, taxable: false, kiwiSaver: false, amount });

const hemi: EmployeePayInput = {
  name: "Hemi Walker",
  frequency: "fortnightly",
  payDate: "2026-10-14",
  taxCode: "M",
  studentLoan: false,
  kiwiSaverStatus: "enrolled",
  kiwiSaverEmployeeRate: "3.5",
  kiwiSaverEmployerRate: "3.5",
  esctRate: "30",
  lines: [earnings("2692.31")],
};

/** Examples PRUN1-PRUN4 and PRUN8 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll — pay runs"). */
describe("one employee's pay in a pay run", () => {
  it("PRUN11: salary per period, ordinary hours and period ends", () => {
    expect(salaryForPeriod("70000.00", "fortnightly")).toBe("2692.31");
    expect(salaryForPeriod("52000.00", "fortnightly")).toBe("2000.00");
    expect(salaryForPeriod("45500.00", "four_weekly")).toBe("3500.00");
    expect(salaryForPeriod("60000.00", "monthly")).toBe("5000.00");
    expect(salaryForPeriod("50000.00", "weekly")).toBe("961.54");
    expect(ordinaryHoursForPeriod("32", "weekly")).toBe("32.00");
    expect(ordinaryHoursForPeriod("37.5", "fortnightly")).toBe("75.00");
    expect(ordinaryHoursForPeriod("40", "four_weekly")).toBe("160.00");
    expect(ordinaryHoursForPeriod("40", "monthly")).toBe("0.00");
    expect(payPeriodEnd("2026-09-28", "fortnightly")).toBe("2026-10-11");
    expect(payPeriodEnd("2026-10-05", "weekly")).toBe("2026-10-11");
    expect(payPeriodEnd("2026-09-14", "four_weekly")).toBe("2026-10-11");
    expect(payPeriodEnd("2026-02-01", "monthly")).toBe("2026-02-28");
    expect(() => payPeriodEnd("2026-02-15", "monthly")).toThrow(`${REFUSED}: a monthly pay period that doesn't start on the 1st of a month.`);
  });

  it("PRUN1: Hemi, fortnightly salary, KiwiSaver 3.5% and 3.5%, ESCT 30%", () => {
    expect(calculateEmployeePay(hemi)).toEqual({
      gross: "2692.31",
      taxableEarnings: "2692.31",
      nonTaxableEarnings: "0.00",
      kiwiSaverEarnings: "2692.31",
      paye: "555.58",
      studentLoan: "0.00",
      kiwiSaverEmployee: "94.23",
      deductions: "0.00",
      netPay: "2042.50",
      kiwiSaverEmployer: "94.23",
      esct: "28.20",
      kiwiSaverEmployerNet: "66.03",
      employerCost: "2786.54",
      extraPay: "0.00",
      extraPayTax: "0.00",
      extraPayTaxRate: null,
      lumpSumLowestRate: false,
    });
  });

  it("PRUN1: Kiri, not enrolled in KiwiSaver", () => {
    const kiri = calculateEmployeePay({ ...hemi, name: "Kiri Tane", kiwiSaverStatus: "not_enrolled", esctRate: null, lines: [earnings("2000.00")] });
    expect(kiri).toMatchObject({ gross: "2000.00", paye: "343.00", kiwiSaverEmployee: "0.00", kiwiSaverEmployer: "0.00", esct: "0.00", netPay: "1657.00", employerCost: "2000.00" });
  });

  it("PRUN2: Sione, hourly with overtime, a taxable allowance, union fees and a reimbursement", () => {
    expect(lineAmount("32", "22.50")).toBe("720.00");
    expect(lineAmount("4", "33.75")).toBe("135.00");
    expect(lineAmount("3.3", "33.75")).toBe("111.38");
    const sione = calculateEmployeePay({
      ...hemi,
      name: "Sione Fifita",
      frequency: "weekly",
      kiwiSaverEmployeeRate: "4",
      esctRate: "17.5",
      lines: [earnings("720.00"), earnings("135.00"), earnings("25.00"), earnings("42.60", false), deduction("8.50")],
    });
    expect(sione).toEqual({
      gross: "922.60",
      taxableEarnings: "880.00",
      nonTaxableEarnings: "42.60",
      kiwiSaverEarnings: "880.00",
      paye: "148.40",
      studentLoan: "0.00",
      kiwiSaverEmployee: "35.20",
      deductions: "8.50",
      netPay: "730.50",
      kiwiSaverEmployer: "30.80",
      esct: "5.25",
      kiwiSaverEmployerNet: "25.55",
      employerCost: "953.40",
      extraPay: "0.00",
      extraPayTax: "0.00",
      extraPayTaxRate: null,
      lumpSumLowestRate: false,
    });
  });

  it("PRUN2: a taxable allowance that doesn't count for KiwiSaver is taxed but not in the KiwiSaver earnings", () => {
    const result = calculateEmployeePay({ ...hemi, lines: [earnings("2692.31"), earnings("100.00", true, false)] });
    expect(result.taxableEarnings).toBe("2792.31");
    expect(result.kiwiSaverEarnings).toBe("2692.31");
    expect(result.kiwiSaverEmployee).toBe("94.23");
  });

  it("PRUN3: IRD's ESS example 4 (four-weekly $3,500, M SL, KiwiSaver 3.5%, ESCT 17.5%)", () => {
    const aroha = calculateEmployeePay({
      ...hemi,
      name: "Aroha Ngata",
      frequency: "four_weekly",
      taxCode: "M SL",
      studentLoan: true,
      esctRate: "17.5",
      lines: [earnings("3500.00")],
    });
    expect(aroha).toMatchObject({
      paye: "589.72",
      studentLoan: "197.28",
      kiwiSaverEmployee: "122.50",
      kiwiSaverEmployer: "122.50",
      esct: "21.35",
      kiwiSaverEmployerNet: "101.15",
      netPay: "2590.50",
      employerCost: "3622.50",
    });
  });

  it("PRUN3: a student loan that disagrees with the tax code is refused", () => {
    expect(() => calculateEmployeePay({ ...hemi, name: "Aroha Ngata", studentLoan: true })).toThrow(
      "Aroha Ngata has a student loan but tax code M has no SL. Fix their tax code or student loan under Employees.",
    );
    expect(() => calculateEmployeePay({ ...hemi, taxCode: "M SL" })).toThrow("tax code M SL has SL but they don't have a student loan ticked");
  });

  it("PRUN4: pay date 1 April 2026 uses 2026-27 rates, so 3% KiwiSaver is refused; 31 March uses 2025-26", () => {
    const march = { ...hemi, payDate: "2026-04-01", kiwiSaverEmployeeRate: "3", kiwiSaverEmployerRate: "3" };
    expect(() => calculateEmployeePay(march)).toThrow("3% isn't a KiwiSaver employee rate on 2026-04-01: use 3.5%, 4%, 6%, 8%, 10%.");
    expect(() => calculateEmployeePay({ ...march, kiwiSaverEmployeeRate: "3.5" })).toThrow(
      "The compulsory KiwiSaver employer contribution on 2026-04-01 is at least 3.5%.",
    );
    expect(calculateEmployeePay({ ...march, payDate: "2026-03-31" })).toMatchObject({
      paye: "553.44",
      kiwiSaverEmployee: "80.76",
      kiwiSaverEmployer: "80.76",
      esct: "24.00",
      kiwiSaverEmployerNet: "56.76",
      netPay: "2058.11",
    });
    expect(calculateEmployeePay({ ...hemi, payDate: "2026-04-01" })).toMatchObject({
      paye: "555.58",
      kiwiSaverEmployee: "94.23",
      esct: "28.20",
      netPay: "2042.50",
    });
  });

  it("PRUN8: savings suspensions and opted-out employees have no KiwiSaver", () => {
    for (const status of ["savings_suspension", "opted_out", "not_eligible"] as const) {
      expect(calculateEmployeePay({ ...hemi, kiwiSaverStatus: status, esctRate: null })).toMatchObject({
        kiwiSaverEmployee: "0.00",
        kiwiSaverEmployer: "0.00",
        esct: "0.00",
        netPay: "2136.73",
      });
    }
  });

  it("PRUN8: refusals", () => {
    expect(() => calculateEmployeePay({ ...hemi, esctRate: null })).toThrow(
      "Hemi Walker has employer KiwiSaver contributions but no ESCT rate. Set it under Employees.",
    );
    expect(() => calculateEmployeePay({ ...hemi, taxCode: "STC" })).toThrow(`${REFUSED}: tailored tax codes (STC)`);
    expect(() => calculateEmployeePay({ ...hemi, lines: [earnings("-10.00")] })).toThrow(`${REFUSED}: amounts below zero`);
    expect(() => calculateEmployeePay({ ...hemi, lines: [earnings("100.00"), deduction("200.00")] })).toThrow(
      `${REFUSED}: Hemi Walker's net pay would be below zero (-115.74).`,
    );
  });

  it("PRUN8: an employee with no earnings this period gets nothing and owes nothing", () => {
    expect(calculateEmployeePay({ ...hemi, lines: [] })).toMatchObject({ gross: "0.00", paye: "0.00", kiwiSaverEmployee: "0.00", esct: "0.00", netPay: "0.00" });
  });
});
