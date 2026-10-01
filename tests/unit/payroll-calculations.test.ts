import { describe, expect, it } from "vitest";
import {
  annualAccEarnersLevy,
  calculateEsct,
  calculatePaye,
  calculateStudentLoan,
  esctRateFor,
  kiwiSaverEmployeeContribution,
  kiwiSaverEmployerContribution,
  TAX_CODES,
} from "@/lib/payroll/calculations";

// Pay dates in each tax year.
const Y2025 = "2025-10-15";
const Y2026 = "2026-10-15";
const REFUSED = "Not supported yet (refused rather than guessed)";

const paye = (gross: string, frequency: string, taxCode: string, payDate: string) =>
  calculatePaye({ gross, frequency, taxCode, payDate });
const studentLoan = (gross: string, frequency: string, taxCode: string, payDate: string) =>
  calculateStudentLoan({ gross, frequency, taxCode, payDate });

describe("PAYE on M and M SL", () => {
  it("PR2: IRD's ESS example 4, four-weekly $3,500 on M SL, in both years", () => {
    expect(paye("3500.00", "four-weekly", "M SL", Y2026)).toBe("589.72");
    expect(paye("3500.00", "four-weekly", "M SL", Y2025)).toBe("586.92");
    expect(paye("3500.00", "four-weekly", "M", Y2026)).toBe("589.72");
  });

  it("PR2: switches rates on 1 April 2026", () => {
    expect(paye("3500.00", "four-weekly", "M", "2026-03-31")).toBe("586.92");
    expect(paye("3500.00", "four-weekly", "M", "2026-04-01")).toBe("589.72");
  });

  it("PR3: more M pays from IRD's documents", () => {
    // Spec 5.20.2 (RD 68 example), 2025-26 spec page 83.
    expect(paye("500.03", "weekly", "M", Y2025)).toBe("74.85");
    expect(paye("515.03", "weekly", "M", Y2025)).toBe("77.72");
    // KS4 April 2026 page 11 (2025-26 rates) and IR340 April 2026 page 20.
    expect(paye("600.00", "weekly", "M", Y2025)).toBe("94.02");
    expect(paye("600.00", "weekly", "M", Y2026)).toBe("94.50");
    // IR335 September 2026 page 28 (Lani).
    expect(paye("880.00", "weekly", "M", Y2026)).toBe("148.40");
    // IR340 April 2026 page 128.
    expect(paye("2000.00", "fortnightly", "M", Y2026)).toBe("343.00");
  });

  it("PR3: the 2026-27 RD 68 example's PAYE is 2025-26's; 2026-27 rates give more", () => {
    expect(paye("500.03", "weekly", "M", Y2026)).toBe("75.25");
    expect(paye("515.03", "weekly", "M", Y2026)).toBe("78.14");
  });

  it("PAYE on nothing is nothing", () => {
    expect(paye("0", "weekly", "M", Y2026)).toBe("0.00");
    expect(paye("0.00", "monthly", "ME", Y2026)).toBe("0.00");
    expect(paye("0", "weekly", "SA", Y2026)).toBe("0.00");
  });
});

describe("ACC earners' levy", () => {
  it("PR4: the annual levy, not rounded, up to the maximum", () => {
    expect(annualAccEarnersLevy({ annualIncome: "45500", payDate: Y2026 })).toBe("796.25");
    expect(annualAccEarnersLevy({ annualIncome: "156640", payDate: Y2026 })).toBe("2741.2");
    expect(annualAccEarnersLevy({ annualIncome: "156641", payDate: Y2026 })).toBe("2741.22");
    expect(annualAccEarnersLevy({ annualIncome: "201552", payDate: Y2026 })).toBe("2741.22");
    expect(annualAccEarnersLevy({ annualIncome: "45500", payDate: Y2025 })).toBe("759.85");
    expect(annualAccEarnersLevy({ annualIncome: "26001", payDate: Y2025 })).toBe("434.2167");
    expect(annualAccEarnersLevy({ annualIncome: "152790", payDate: Y2025 })).toBe("2551.59");
  });

  it("PR4: annual income must be whole dollars", () => {
    expect(() => annualAccEarnersLevy({ annualIncome: "45500.50", payDate: Y2026 })).toThrow("whole dollars");
  });

  it("PR4: IR341 April 2026 page 103, four-weekly $15,504 on M (above the maximum)", () => {
    expect(paye("15504.00", "four-weekly", "M", Y2026)).toBe("4648.00");
  });
});

describe("PAYE on ME (independent earner tax credit)", () => {
  it("PR5: IR340 April 2026 pages 20, 37 and 81", () => {
    expect(paye("600.00", "weekly", "ME", Y2026)).toBe("84.50");
    expect(paye("1280.00", "weekly", "ME", Y2026)).toBe("248.19");
    expect(paye("1280.00", "weekly", "M", Y2026)).toBe("256.79");
    expect(paye("3013.00", "weekly", "ME", Y2026)).toBe("852.34");
    expect(paye("3013.00", "weekly", "M", Y2026)).toBe("852.34");
    expect(paye("600.00", "weekly", "ME SL", Y2026)).toBe("84.50");
  });
});

describe("flat-rate codes", () => {
  it("PR6: secondary codes on whole dollars (IR340 April 2026 page 213, IR341 page 286)", () => {
    expect(["SB", "S", "SH", "ST", "SA"].map((code) => paye("457.00", "weekly", code, Y2026))).toEqual([
      "55.98",
      "87.97",
      "145.09",
      "158.80",
      "186.22",
    ]);
    expect(paye("457.99", "weekly", "S", Y2026)).toBe("87.97");
    expect(paye("15504.00", "four-weekly", "SA", Y2026)).toBe("6317.88");
    expect(paye("15504.00", "four-weekly", "SA SL", Y2026)).toBe("6317.88");
  });

  it("PR7: ND (IR335 September 2026 page 13, Brad)", () => {
    expect(paye("860.00", "weekly", "ND", Y2026)).toBe("402.05");
    expect(paye("860.00", "weekly", "ND", Y2025)).toBe("401.36");
  });

  it("PR8: NSW (Mike, 2026-27 spec page 26 and 2025-26 spec page 20)", () => {
    expect(paye("960.00", "weekly", "NSW", Y2026)).toBe("117.60");
    expect(paye("800.00", "weekly", "NSW", Y2025)).toBe("97.36");
  });

  it("PR9: CAE and EDW", () => {
    expect(paye("457.89", "weekly", "CAE", Y2026)).toBe("87.97");
    expect(paye("457.89", "weekly", "EDW", Y2026)).toBe("87.97");
    expect(paye("457.89", "weekly", "CAE", Y2025)).toBe("87.60");
  });
});

describe("student loan deductions", () => {
  it("PR10: main income, over the pay period threshold", () => {
    expect(studentLoan("3500.00", "four-weekly", "M SL", Y2026)).toBe("197.28");
    expect(studentLoan("3500.00", "four-weekly", "M SL", Y2025)).toBe("197.28");
    expect(studentLoan("464.00", "weekly", "M SL", Y2026)).toBe("0.00");
    expect(studentLoan("464.99", "weekly", "M SL", Y2026)).toBe("0.00");
    expect(studentLoan("465.00", "weekly", "ME SL", Y2026)).toBe("0.12");
    expect(studentLoan("2600.00", "monthly", "M SL", Y2026)).toBe("70.72");
    expect(studentLoan("15504.00", "four-weekly", "M SL", Y2026)).toBe("1637.76");
    expect(studentLoan("100.00", "weekly", "M SL", Y2026)).toBe("0.00");
  });

  it("PR11: secondary income, no threshold; nothing without SL", () => {
    expect(studentLoan("457.00", "weekly", "S SL", Y2026)).toBe("54.84");
    expect(studentLoan("15504.00", "four-weekly", "SA SL", Y2026)).toBe("1860.48");
    for (const code of ["M", "ME", "SB", "S", "SH", "ST", "SA", "ND", "NSW", "CAE", "EDW"]) {
      expect(studentLoan("3500.00", "four-weekly", code, Y2026), code).toBe("0.00");
    }
  });
});

describe("KiwiSaver", () => {
  const employee = (gross: string, rate: string, payDate: string, temporaryRateReduction?: boolean) =>
    kiwiSaverEmployeeContribution({ gross, rate, payDate, temporaryRateReduction });
  const employer = (gross: string, rate: string, payDate: string, temporaryRateReduction?: boolean) =>
    kiwiSaverEmployerContribution({ gross, rate, payDate, temporaryRateReduction });

  it("PR12: employee deductions are truncated to cents", () => {
    expect(employee("500.03", "4", Y2025)).toBe("20.00");
    expect(employee("3500.00", "3.5", Y2026)).toBe("122.50");
    expect(employee("3500.00", "3", Y2025)).toBe("105.00");
    expect(employee("600.00", "3.5", Y2026)).toBe("21.00");
    expect(employee("465.00", "3.5", Y2026)).toBe("16.27");
    expect(employee("465.00", "3.50", Y2026)).toBe("16.27");
  });

  it("PR12: only IRD's employee rates for the pay date", () => {
    expect(() => employee("600.00", "3.5", Y2025)).toThrow("isn't a KiwiSaver employee rate on 2025-10-15");
    expect(() => employee("600.00", "3", Y2026)).toThrow("use 3.5%, 4%, 6%, 8%, 10%");
    expect(() => employee("600.00", "5", Y2026)).toThrow("isn't a KiwiSaver employee rate");
    expect(employee("600.00", "3", "2026-03-31")).toBe("18.00");
    expect(() => employee("600.00", "3", "2026-04-01")).toThrow("isn't a KiwiSaver employee rate");
  });

  it("PR12: 3% only with a temporary rate reduction, from 1 April 2026", () => {
    expect(employee("600.00", "3", Y2026, true)).toBe("18.00");
    expect(() => employee("600.00", "4", Y2026, true)).toThrow("with a temporary rate reduction: use 3%");
    expect(() => employee("600.00", "3", Y2025, true)).toThrow("no KiwiSaver temporary rate reduction");
  });

  it("PR13: employer contributions, truncated to cents, at least the minimum", () => {
    expect(employer("500.03", "3", Y2025)).toBe("15.00");
    expect(employer("2600.00", "3.5", Y2026)).toBe("91.00");
    expect(employer("800.00", "10", Y2026)).toBe("80.00");
    expect(employer("3500.00", "3.5", Y2026)).toBe("122.50");
    expect(employer("600.00", "3", "2026-03-31")).toBe("18.00");
    expect(() => employer("600.00", "3", "2026-04-01")).toThrow("at least 3.5%");
    expect(() => employer("600.00", "2", Y2025)).toThrow("at least 3%");
    expect(employer("600.00", "3", Y2026, true)).toBe("18.00");
    expect(() => employer("600.00", "2.5", Y2026, true)).toThrow("at least 3% with a temporary rate reduction");
  });
});

describe("ESCT", () => {
  const rate = (thresholdAmount: string, payDate = Y2026) => esctRateFor({ thresholdAmount, payDate });
  const esct = (employerContribution: string, esctRate: string, payDate = Y2026) =>
    calculateEsct({ employerContribution, esctRate, payDate });

  it("PR14: the rate for a threshold amount", () => {
    expect(rate("54216.00")).toBe("17.5");
    expect(rate("14425.88", Y2025)).toBe("10.5");
    expect(rate("23577.43", Y2025)).toBe("17.5");
    expect(rate("38625.00", Y2025)).toBe("17.5");
    expect(rate("48300")).toBe("17.5");
    expect(rate("72450")).toBe("30");
    expect(rate("0")).toBe("10.5");
    expect(rate("18720.00")).toBe("10.5");
    expect(rate("18721.00")).toBe("17.5");
    expect(rate("64200")).toBe("17.5");
    expect(rate("93721")).toBe("33");
    expect(rate("216000")).toBe("33");
    expect(rate("216001")).toBe("39");
  });

  it("PR14: refuses amounts between IRD's bands", () => {
    expect(() => rate("18720.50")).toThrow(
      `${REFUSED}: an ESCT rate threshold amount of 18720.5 is between two of IRD's bands.`,
    );
  });

  it("PR15: whole dollars of the contribution x rate, truncated; net keeps the cents", () => {
    expect(esct("122.50", "17.5")).toEqual({ esct: "21.35", netContribution: "101.15" });
    expect(esct("105.00", "17.5", Y2025)).toEqual({ esct: "18.37", netContribution: "86.63" });
    expect(esct("79.04", "17.5")).toEqual({ esct: "13.82", netContribution: "65.22" });
    expect(esct("39.52", "17.5").esct).toBe("6.82");
    expect(esct("24.00", "17.5")).toEqual({ esct: "4.20", netContribution: "19.80" });
    expect(esct("91.00", "17.5")).toEqual({ esct: "15.92", netContribution: "75.08" });
    expect(esct("91.17", "17.5")).toEqual({ esct: "15.92", netContribution: "75.25" });
    expect(esct("0.99", "39")).toEqual({ esct: "0.00", netContribution: "0.99" });
  });

  it("PR15: only the ESCT rates in effect", () => {
    expect(() => esct("100.00", "20")).toThrow("isn't an ESCT rate on 2026-10-15: use 10.5%, 17.5%, 30%, 33%, 39%");
  });
});

describe("refused and invalid input", () => {
  it("knows IRD's tax codes, with spacing and case tidied", () => {
    expect(TAX_CODES).toHaveLength(18);
    expect(paye("3500.00", "four-weekly", " m  sl ", Y2026)).toBe("589.72");
    expect(() => paye("500.00", "weekly", "X", Y2026)).toThrow(`"X" isn't an IRD tax code Tohyee knows.`);
    expect(() => paye("500.00", "weekly", "ND SL", Y2026)).toThrow("isn't an IRD tax code");
  });

  it("refuses STC and WT", () => {
    expect(() => paye("500.00", "weekly", "STC", Y2026)).toThrow(`${REFUSED}: tailored tax codes (STC)`);
    expect(() => paye("500.00", "weekly", "WT", Y2026)).toThrow(`${REFUSED}: schedular payments (WT)`);
    expect(() => studentLoan("500.00", "weekly", "STC", Y2026)).toThrow(REFUSED);
  });

  it("refuses other pay frequencies", () => {
    for (const frequency of ["daily", "three-weekly", "half-monthly", "annual", ""]) {
      expect(() => paye("500.00", frequency, "M", Y2026), frequency).toThrow(`${REFUSED}: pay frequency`);
    }
  });

  it("refuses negative amounts and more than 2 decimal places", () => {
    expect(() => paye("-1.00", "weekly", "M", Y2026)).toThrow(`${REFUSED}: Gross pay below zero.`);
    expect(() => paye("1.005", "weekly", "M", Y2026)).toThrow("more than 2 decimal places");
    expect(() => paye("", "weekly", "M", Y2026)).toThrow("Gross pay is required.");
    expect(() => paye("abc", "weekly", "M", Y2026)).toThrow("not a valid decimal number");
    expect(() => esct("-5.00", "17.5")).toThrow(REFUSED);
    expect(() => rate("-1")).toThrow(REFUSED);
    expect(() => kiwiSaverEmployeeContribution({ gross: "100", rate: "-4", payDate: Y2026 })).toThrow(
      "between 0% and 100%",
    );
  });

  it("refuses pay dates no edition covers", () => {
    expect(() => paye("500.00", "weekly", "M", "2027-04-01")).toThrow(REFUSED);
    expect(() => studentLoan("500.00", "weekly", "M SL", "2025-03-31")).toThrow(REFUSED);
    expect(() => kiwiSaverEmployeeContribution({ gross: "100", rate: "4", payDate: "2027-04-01" })).toThrow(REFUSED);
    expect(() => esctRateFor({ thresholdAmount: "100", payDate: "2027-04-01" })).toThrow(REFUSED);
  });

  function esct(employerContribution: string, esctRate: string) {
    return calculateEsct({ employerContribution, esctRate, payDate: Y2026 });
  }
  function rate(thresholdAmount: string) {
    return esctRateFor({ thresholdAmount, payDate: Y2026 });
  }
});
