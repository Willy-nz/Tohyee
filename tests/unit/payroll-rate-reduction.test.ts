import { describe, expect, it } from "vitest";
import { calculateEmployeePay, type EmployeePayInput } from "@/lib/payroll/pay-calculation";

/**
 * Example PR13b in docs/ACCOUNTING-EXAMPLES.md (review issue #141): a
 * KiwiSaver temporary rate reduction approved by IRD, from 1 Apr 2026 to
 * 31 Mar 2027.
 */
const hemi: EmployeePayInput = {
  name: "Hemi Walker",
  frequency: "weekly",
  payDate: "2026-05-15",
  taxCode: "M",
  studentLoan: false,
  kiwiSaverStatus: "enrolled",
  kiwiSaverEmployeeRate: "3",
  kiwiSaverEmployerRate: "3",
  esctRate: "17.5",
  kiwiSaverReduction: { from: "2026-04-01", to: "2027-03-31" },
  lines: [{ category: "earnings", taxable: true, kiwiSaver: true, extraPay: false, accLevy: true, amount: "1000.00" }],
};

describe("PR13b: a temporary rate reduction approved by IRD", () => {
  it("takes 3% and the employer contributes 3% within the approval's dates", () => {
    const pay = calculateEmployeePay(hemi);
    expect(pay.kiwiSaverEmployee).toBe("30.00");
    expect(pay.kiwiSaverEmployer).toBe("30.00");
  });

  it("refuses 3% after the approval ends, as for anyone without one", () => {
    // Inside the rates Tohyee has: an approval that ended on 30 Sep 2026.
    const ended = { ...hemi, payDate: "2026-10-15", kiwiSaverReduction: { from: "2026-04-01", to: "2026-09-30" } };
    expect(() => calculateEmployeePay(ended)).toThrow("3% isn't a KiwiSaver employee rate on 2026-10-15: use");
    expect(() => calculateEmployeePay({ ...hemi, payDate: "2026-10-15", kiwiSaverReduction: null })).toThrow("3% isn't a KiwiSaver employee rate");
    // The example's own dates: Tohyee has no rates after 31 Mar 2027 yet, so that pay is refused too.
    expect(() => calculateEmployeePay({ ...hemi, payDate: "2027-04-15" })).toThrow("Tohyee has no IRD payroll rates for pay dates on 2027-04-15");
  });

  it("isn't needed for pays dated before 1 Apr 2026 (3% was the rate then)", () => {
    const march = calculateEmployeePay({ ...hemi, payDate: "2026-03-27", kiwiSaverReduction: { from: "2026-03-01", to: "2027-03-31" } });
    expect(march.kiwiSaverEmployee).toBe("30.00");
    expect(march.kiwiSaverEmployer).toBe("30.00");
  });
});
