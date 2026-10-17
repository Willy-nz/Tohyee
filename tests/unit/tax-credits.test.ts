import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { ir3Return } from "@/lib/tax/income/ir3";
import { ir4Return } from "@/lib/tax/income/ir4";
import { type TaxpayerType, workpaper } from "@/lib/tax/income/rules";

const paper = (type: TaxpayerType, income: string, credits: { tax?: string; imputation?: string; overseas?: string; losses?: string } = {}) =>
  workpaper({
    type,
    year: 2026,
    accounts: [],
    typedAdjustments: [{ description: "Income", amount: dec(income) }],
    otherIncome: dec("0"),
    lossesBroughtForward: dec(credits.losses ?? "0"),
    taxCredits: dec(credits.tax ?? "0"),
    imputationCredits: dec(credits.imputation ?? "0"),
    overseasTaxPaid: dec(credits.overseas ?? "0"),
  });

describe("imputation credits and overseas tax apart from refundable credits (ITX58-ITX61, not yet reviewed)", () => {
  it("ITX58 a company: overseas tax, then imputation credits, then the other credits", () => {
    const result = paper("company", "100000", { tax: "140", imputation: "2000", overseas: "3000" });
    expect([result.tax, result.rit, result.excessImputationCredits, result.imputationLoss]).toEqual(["28000.00", "22860.00", "0.00", "0.00"]);
    const ir4 = ir4Return({ workpaper: result, paidTowardsYear: dec("0") });
    expect([ir4.boxes["30B"], ir4.boxes["30C"], ir4.boxes["30D"], ir4.boxes["30G"], ir4.boxes["30H"], ir4.boxes["30I"], ir4.boxes["30J"], ir4.residual]).toEqual([
      "28000.00", "3000.00", "25000.00", "2000.00", "23000.00", "140.00", "22860.00", "debit",
    ]);
  });

  it("ITX59 a company's excess imputation credits become a loss; RWT is still refunded", () => {
    const result = paper("company", "10000", { tax: "140", imputation: "4200" });
    expect([result.tax, result.excessImputationCredits, result.imputationLoss, result.lossCarriedForward, result.taxToPay, result.rit]).toEqual(["2800.00", "1400.00", "5000.00", "5000.00", "-140.00", "0.00"]);
    const ir4 = ir4Return({ workpaper: result, paidTowardsYear: dec("0") });
    expect([ir4.boxes["30H"], ir4.boxes["30J"], ir4.residual, ir4.boxes["30L"], ir4.outcome]).toEqual(["0.00", "140.00", "credit", "140.00", "refund"]);
  });

  it("ITX60 overseas tax more than the tax brings it to nil and no further", () => {
    const result = paper("company", "10000", { overseas: "3500" });
    expect([result.taxToPay, result.rit]).toEqual(["0.00", "0.00"]);
    expect(ir4Return({ workpaper: result, paidTowardsYear: dec("0") }).boxes["30D"]).toBe("0.00");
  });

  it("ITX61 an individual: the worksheet's boxes 5 to 14, and excess imputation credits carry forward as credits", () => {
    const result = paper("individual", "60000", { tax: "1050", imputation: "1500", overseas: "500" });
    const ir3 = ir3Return({ workpaper: result, paidTowardsYear: dec("0") });
    expect([ir3.boxes.W4, ir3.boxes.W5, ir3.boxes.W6, ir3.boxes.W7, ir3.boxes.W9, ir3.boxes.W10, ir3.boxes.W12, ir3.boxes.W14, ir3.residual]).toEqual([
      "10220.50", "500.00", "9720.50", "1500.00", "1500.00", "8220.50", "1050.00", "7170.50", "debit",
    ]);
    expect(result.rit).toBe("7170.50");
    const small = paper("individual", "5000", { imputation: "800" });
    expect([small.tax, small.excessImputationCredits, small.imputationLoss, small.lossCarriedForward]).toEqual(["525.00", "275.00", "0.00", "0.00"]);
  });
});
