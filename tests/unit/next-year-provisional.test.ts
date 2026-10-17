import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { ir3Return } from "@/lib/tax/income/ir3";
import { ir4Return } from "@/lib/tax/income/ir4";
import { nextYearStandard, type TaxpayerType, workpaper } from "@/lib/tax/income/rules";

const paper = (type: TaxpayerType, income: string, credits: { tax?: string; imputation?: string; broughtForward?: string } = {}) =>
  workpaper({
    type,
    year: 2026,
    accounts: [],
    typedAdjustments: [{ description: "Income", amount: dec(income) }],
    otherIncome: dec("0"),
    lossesBroughtForward: dec("0"),
    taxCredits: dec(credits.tax ?? "0"),
    imputationCredits: dec(credits.imputation ?? "0"),
    imputationBroughtForward: dec(credits.broughtForward ?? "0"),
  });

describe("next year's provisional tax and imputation credits brought forward (ITX62-ITX65, not yet reviewed)", () => {
  it("ITX62 a company's 33A and 33B: this year's RIT plus 5%", () => {
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("company", "100000", { tax: "5140" }), paidTowardsYear: dec("0") });
    expect(ir4.boxes["30J"]).toBe("22860.00");
    expect(ir4.nextYear).toEqual({ incomeYear: 2027, option: "S", amount: "24003.00" });
  });

  it("ITX63 none required with RIT of 5,000.00 or less", () => {
    expect(nextYearStandard(dec("5000"))).toBeNull();
    expect(nextYearStandard(dec("5000.01"))).toEqual({ option: "S", amount: "5250.01" });
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("company", "10000", { tax: "140" }), paidTowardsYear: dec("0") });
    expect([ir4.boxes["30J"], ir4.nextYear]).toEqual(["2660.00", null]);
  });

  it("ITX64 an individual's 39A and 39B, rounded to the cent", () => {
    const ir3 = ir3Return({ incomeYear: 2026, workpaper: paper("individual", "60000", { tax: "3050" }), paidTowardsYear: dec("0") });
    expect(ir3.boxes.W14).toBe("7170.50");
    expect(ir3.nextYear).toEqual({ incomeYear: 2027, option: "S", amount: "7529.03" });
  });

  it("ITX65 an individual's excess imputation credits brought forward come off with this year's", () => {
    const result = paper("individual", "5000", { imputation: "300", broughtForward: "400" });
    const ir3 = ir3Return({ incomeYear: 2026, workpaper: result, paidTowardsYear: dec("0") });
    expect([ir3.boxes.W6, ir3.boxes.W7, ir3.boxes.W8, ir3.boxes.W9, ir3.boxes.W10, result.excessImputationCredits]).toEqual(["525.00", "300.00", "400.00", "700.00", "0.00", "175.00"]);
    // Ignored for a company, which turns excess credits into a loss instead.
    expect(paper("company", "5000", { broughtForward: "400" }).imputationBroughtForward).toBe("0.00");
  });
});
