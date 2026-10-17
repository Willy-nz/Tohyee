import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { ir3Return } from "@/lib/tax/income/ir3";
import { workpaper } from "@/lib/tax/income/rules";

const paper = (business: string, other = "0", losses = "0", credits = "0") =>
  workpaper({ type: "individual", year: 2026, accounts: [], typedAdjustments: [{ description: "Business", amount: dec(business) }], otherIncome: dec(other), lossesBroughtForward: dec(losses), taxCredits: dec(credits) });

describe("IR3 income boxes and tax worksheet (ITX54-ITX57, from IRD's 2026 IR3 and IR3G, not yet reviewed)", () => {
  it("ITX54 a sole trader's profit, less provisional tax paid", () => {
    const ir3 = ir3Return({ workpaper: paper("60000"), paidTowardsYear: dec("5000") });
    expect(ir3.boxes).toMatchObject({ "24": "60000.00", other: "0.00", "28": "60000.00", "30": "60000.00", "32": "60000.00", W1: "60000.00", W2: "10220.50", W10: "10220.50", W14: "10220.50", W15: "5000.00", W16: "5220.50" });
    expect([ir3.residual, ir3.outcome]).toEqual(["debit", "tax_to_pay"]);
  });

  it("ITX55 other income is shown on its own and counted in box 28; credits come off", () => {
    const ir3 = ir3Return({ workpaper: paper("40000", "10000", "0", "1050"), paidTowardsYear: dec("0") });
    expect([ir3.boxes["24"], ir3.boxes.other, ir3.boxes["28"], ir3.boxes.W2, ir3.boxes.W12, ir3.boxes.W14, ir3.boxes.W16]).toEqual(["40000.00", "10000.00", "50000.00", "7658.00", "1050.00", "6608.00", "6608.00"]);
    expect([ir3.residual, ir3.outcome]).toEqual(["debit", "tax_to_pay"]);
  });

  it("ITX56 losses brought forward use up the income; the credits come back", () => {
    const ir3 = ir3Return({ workpaper: paper("20000", "0", "30000", "200"), paidTowardsYear: dec("0") });
    expect([ir3.boxes["31A"], ir3.boxes["31B"], ir3.boxes["32"], ir3.boxes.W2, ir3.boxes.W14, ir3.residual, ir3.boxes.W16, ir3.outcome]).toEqual(["30000.00", "20000.00", "0.00", "0.00", "200.00", "credit", "200.00", "refund"]);
  });

  it("ITX57 a loss year: worksheet box 1 is 0.00 and provisional tax paid is refunded", () => {
    const ir3 = ir3Return({ workpaper: paper("-8000"), paidTowardsYear: dec("1000") });
    expect([ir3.boxes["32"], ir3.boxes.W1, ir3.boxes.W2, ir3.boxes.W14, ir3.residual, ir3.boxes.W16, ir3.outcome]).toEqual(["-8000.00", "0.00", "0.00", "0.00", "credit", "1000.00", "refund"]);
  });
});
