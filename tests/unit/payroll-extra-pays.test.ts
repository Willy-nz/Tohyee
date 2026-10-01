import { describe, expect, it } from "vitest";
import { annualiseForExtraPay, calculateExtraPayTax, secondaryLowThreshold } from "@/lib/payroll/calculations";
import { calculateEmployeePay, type EmployeePayInput } from "@/lib/payroll/pay-calculation";

const REFUSED = "Not supported yet (refused rather than guessed)";
const PAY_DATE = "2026-11-04";

const tax = (extraPay: string, annualised: string, taxCode = "M", accLiable = extraPay) =>
  calculateExtraPayTax({ extraPay, accLiable, annualised, taxCode, payDate: PAY_DATE });

/**
 * Examples XP1-XP7 in docs/ACCOUNTING-EXAMPLES.md ("Extra pays, back pay and
 * final pays"): IRD's own examples from the payroll specification 2026-27
 * (5.11.1, 5.11.2, 5.12) and IR335 (September 2026).
 */
describe("tax on extra pays (IRD's examples)", () => {
  it("XP1: spec 5.11.1 example 1, the levy partly over its maximum, truncated once (decision 127)", () => {
    expect(annualiseForExtraPay({ method: "four_weeks", frequency: "monthly", pays: ["10000.00"] })).toBe("120000.00");
    // IRD's example gives the four weeks' $10,000 as a × 13 figure.
    const result = tax("30000.56", "130000.00");
    expect(result).toEqual({ tax: "10366.40", taxRate: "33", grossedUp: "160000", lowestRate: false, method: "extra_pay" });
    // IRD prints $9,900.18 + $466.21 = $10,366.39 (each part truncated); its steps 5.1-5.2 truncate once.
    expect(result.tax).not.toBe("10366.39");
  });

  it("XP2: spec 5.11.1 example 2, 39% and no levy above the maximum", () => {
    expect(annualiseForExtraPay({ method: "four_weeks", frequency: "weekly", pays: ["3750.00", "3750.00", "3750.00", "3750.00"] })).toBe(
      "195000.00",
    );
    expect(tax("15000.00", "195000.00")).toMatchObject({ tax: "5850.00", taxRate: "39", grossedUp: "210000", lowestRate: false });
  });

  it("XP3: spec 5.11.1 example 3, a signing bonus with no pay before it, at the lowest rate", () => {
    expect(annualiseForExtraPay({ method: "four_weeks", frequency: "fortnightly", pays: [] })).toBe("0.00");
    expect(tax("10000.00", "0.00")).toEqual({ tax: "1225.00", taxRate: "10.5", grossedUp: "10000", lowestRate: true, method: "extra_pay" });
  });

  it("XP4-XP5: secondary codes add their low threshold (spec 5.11.2)", () => {
    expect(secondaryLowThreshold("SB", PAY_DATE)).toBe("0");
    expect(secondaryLowThreshold("S", PAY_DATE)).toBe("15601");
    expect(secondaryLowThreshold("SH", PAY_DATE)).toBe("53501");
    expect(secondaryLowThreshold("ST", PAY_DATE)).toBe("78101");
    expect(secondaryLowThreshold("SA", PAY_DATE)).toBe("180001");
    expect(tax("1000.00", "6500.00", "SH")).toMatchObject({ tax: "317.50", taxRate: "30", grossedUp: "61001", lowestRate: false });
    const fortnights = annualiseForExtraPay({ method: "four_weeks", frequency: "fortnightly", pays: ["2300.00", "2395.00"] });
    expect(fortnights).toBe("61035.00");
    expect(tax("40000.00", fortnights, "ST SL")).toMatchObject({ tax: "13506.33", taxRate: "33", grossedUp: "179136" });
    // SB at the lowest rate is flagged too.
    expect(tax("1000.00", "5000.00", "SB")).toMatchObject({ tax: "122.50", taxRate: "10.5", lowestRate: true });
  });

  it("XP6: end of employment, the last two paid periods (spec 5.12, IR335 page 40)", () => {
    const connor = annualiseForExtraPay({ method: "end_of_employment", frequency: "weekly", pays: ["550.00", "650.00"] });
    expect(connor).toBe("31200.00");
    expect(tax("1000.00", connor, "M", "0.00")).toMatchObject({ tax: "175.00", taxRate: "17.5", grossedUp: "32200" });
    const kelvin = annualiseForExtraPay({ method: "end_of_employment", frequency: "weekly", pays: ["500.00", "600.00"] });
    expect(tax("2000.00", kelvin)).toMatchObject({ tax: "385.00", taxRate: "17.5", grossedUp: "30600" });
    const tama = annualiseForExtraPay({ method: "end_of_employment", frequency: "weekly", pays: ["1000.00", "1000.00"] });
    expect(tax("400.00", tama)).toMatchObject({ tax: "77.00", taxRate: "17.5" });
    expect(annualiseForExtraPay({ method: "end_of_employment", frequency: "fortnightly", pays: ["1.00", "1.00"] })).toBe("26.00");
    expect(annualiseForExtraPay({ method: "end_of_employment", frequency: "four-weekly", pays: ["1000.00", "1000.01"] })).toBe("13000.065");
    expect(annualiseForExtraPay({ method: "end_of_employment", frequency: "monthly", pays: ["5000.00", "5000.00"] })).toBe("60000.00");
  });

  it("XP7: Heidi (IR335), ME without the credit, and ND and NSW at their flat rate", () => {
    const heidi = annualiseForExtraPay({ method: "four_weeks", frequency: "weekly", pays: ["1537.50", "1537.50", "1537.50", "1537.50"] });
    expect(heidi).toBe("79950.00");
    expect(tax("1000.00", heidi)).toMatchObject({ tax: "347.50", taxRate: "33" });
    expect(tax("1000.00", heidi, "ME")).toMatchObject({ tax: "347.50", taxRate: "33" });
    expect(tax("1000.00", heidi, "ND")).toEqual({ tax: "467.50", taxRate: "45", grossedUp: null, lowestRate: false, method: "flat_rate" });
    expect(tax("1000.00", heidi, "NSW")).toEqual({ tax: "122.50", taxRate: "10.5", grossedUp: null, lowestRate: false, method: "flat_rate" });
  });

  it("refuses what IRD's rules don't clearly answer", () => {
    expect(() => annualiseForExtraPay({ method: "four_weeks", frequency: "weekly", pays: ["1.00", "1.00"] })).toThrow(
      `${REFUSED}: an extra pay when the four weeks before it hold 2 weekly pays (IRD's rules annualise 4 weekly pays, or none).`,
    );
    expect(() => annualiseForExtraPay({ method: "four_weeks", frequency: "fortnightly", pays: ["1.00", "1.00", "1.00"] })).toThrow(REFUSED);
    expect(() => annualiseForExtraPay({ method: "end_of_employment", frequency: "weekly", pays: ["1.00"] })).toThrow(
      `${REFUSED}: an extra pay on leaving with 1 paid pay period before the final pay (IRD's rule annualises the last 2).`,
    );
    expect(() => tax("100.00", "0.00", "CAE")).toThrow(`${REFUSED}: extra pays for tax code CAE`);
    expect(() => tax("100.00", "0.00", "EDW")).toThrow(REFUSED);
    expect(() => tax("100.00", "0.00", "STC")).toThrow(REFUSED);
    expect(() => tax("100.00", "0.00", "ND", "0.00")).toThrow(`${REFUSED}: redundancy for tax code ND`);
    // Redundancy with a levy-liable extra pay where the maximum falls inside them.
    expect(() => tax("40000.00", "130000.00", "M", "20000.00")).toThrow(
      `${REFUSED}: redundancy with other extra pays when the ACC earners' levy's maximum falls inside them.`,
    );
    // Both below the maximum, or the annualised income above it, is clear.
    expect(tax("2000.00", "30000.00", "M", "1000.00")).toMatchObject({ tax: "367.50" });
    expect(tax("2000.00", "160000.00", "M", "1000.00")).toMatchObject({ tax: "660.00" });
    expect(() => tax("100.00", "0.00", "M", "100.01")).toThrow();
  });
});

const earnings = (amount: string, extra: Partial<{ extraPay: boolean; accLevy: boolean; kiwiSaver: boolean }> = {}) => ({
  category: "earnings" as const,
  taxable: true,
  kiwiSaver: extra.kiwiSaver ?? true,
  extraPay: extra.extraPay ?? false,
  accLevy: extra.accLevy ?? true,
  amount,
});

const heidi: EmployeePayInput = {
  name: "Heidi Bonus",
  frequency: "weekly",
  payDate: PAY_DATE,
  taxCode: "M",
  studentLoan: false,
  kiwiSaverStatus: "enrolled",
  kiwiSaverEmployeeRate: "3.5",
  kiwiSaverEmployerRate: "3.5",
  esctRate: "30",
  lines: [earnings("1537.50"), earnings("1000.00", { extraPay: true })],
  extraPayAnnualised: "79950.00",
};

describe("one employee's pay with extra pays", () => {
  it("XP8: Heidi's bonus in a normal weekly pay", () => {
    expect(calculateEmployeePay(heidi)).toEqual({
      gross: "2537.50",
      taxableEarnings: "2537.50",
      nonTaxableEarnings: "0.00",
      kiwiSaverEarnings: "2537.50",
      paye: "687.11",
      studentLoan: "0.00",
      kiwiSaverEmployee: "88.81",
      deductions: "0.00",
      netPay: "1761.58",
      kiwiSaverEmployer: "88.81",
      esct: "26.40",
      kiwiSaverEmployerNet: "62.41",
      employerCost: "2626.31",
      extraPay: "1000.00",
      extraPayTax: "347.50",
      extraPayTaxRate: "33",
      lumpSumLowestRate: false,
    });
  });

  it("XP7: Rama's student loan is on the pay for the period, extra pay included (IR335 page 42)", () => {
    const rama = calculateEmployeePay({
      ...heidi,
      name: "Rama Loan",
      frequency: "fortnightly",
      taxCode: "M SL",
      studentLoan: true,
      kiwiSaverStatus: "not_enrolled",
      lines: [earnings("1700.00"), earnings("100.00"), earnings("10100.00", { extraPay: true })],
      extraPayAnnualised: "46800.00",
    });
    expect(rama).toMatchObject({ studentLoan: "1316.64", paye: "3511.25", extraPayTax: "3206.75", extraPayTaxRate: "30", netPay: "7072.11" });
  });

  it("XP13: redundancy has no levy and no KiwiSaver; the ordinary pay is taxed as usual", () => {
    const connor = calculateEmployeePay({
      ...heidi,
      name: "Connor Redundant",
      esctRate: "17.5",
      lines: [earnings("250.00"), earnings("1000.00", { extraPay: true, accLevy: false, kiwiSaver: false })],
      extraPayAnnualised: "31200.00",
    });
    expect(connor).toMatchObject({
      gross: "1250.00",
      kiwiSaverEarnings: "250.00",
      paye: "205.62",
      kiwiSaverEmployee: "8.75",
      kiwiSaverEmployer: "8.75",
      esct: "1.40",
      kiwiSaverEmployerNet: "7.35",
      netPay: "1035.63",
      extraPayTax: "175.00",
    });
  });

  it("XP9: a pay that is only an extra pay, at the lowest rate", () => {
    const sam = calculateEmployeePay({
      ...heidi,
      name: "Sam Signing",
      kiwiSaverStatus: "not_enrolled",
      lines: [earnings("10000.00", { extraPay: true })],
      extraPayAnnualised: "0.00",
    });
    expect(sam).toMatchObject({ paye: "1225.00", netPay: "8775.00", lumpSumLowestRate: true, extraPayTaxRate: "10.5" });
  });

  it("an extra pay needs its annualised income; a pay without extra pays is unchanged", () => {
    expect(() => calculateEmployeePay({ ...heidi, extraPayAnnualised: null })).toThrow("annualised");
    const plain = calculateEmployeePay({ ...heidi, lines: [earnings("1537.50")], extraPayAnnualised: null });
    expect(plain).toMatchObject({ paye: "339.61", extraPay: "0.00", extraPayTax: "0.00", extraPayTaxRate: null, lumpSumLowestRate: false });
  });
});
