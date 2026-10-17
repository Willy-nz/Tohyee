import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { ir4Return } from "@/lib/tax/income/ir4";
import { workpaper } from "@/lib/tax/income/rules";

const paper = (income: string, losses = "0", credits = "0") =>
  workpaper({ type: "company", year: 2026, accounts: [], typedAdjustments: [{ description: "Income", amount: dec(income) }], otherIncome: dec("0"), lossesBroughtForward: dec(losses), taxCredits: dec(credits) });

describe("IR4 income and tax boxes (ITX50-ITX53, from IRD's 2026 IR4 form, not yet reviewed)", () => {
  it("ITX50 a profit, credits and provisional tax paid leave tax to pay", () => {
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("100000", "0", "140"), paidTowardsYear: dec("20000") });
    expect(ir4.boxes).toMatchObject({
      "20B": "100000.00", "23": "100000.00", "24B": "0.00", "25": "100000.00", "26A": "0.00", "26B": "0.00", "27": "100000.00", "29": "100000.00",
      "30A": "100000.00", "30B": "28000.00", "30D": "28000.00", "30F": "28000.00", "30H": "28000.00", "30I": "140.00", "30J": "27860.00", "30K": "20000.00", "30L": "7860.00",
    });
    expect([ir4.residual, ir4.outcome]).toEqual(["debit", "tax_to_pay"]);
  });

  it("ITX51 paying more than the residual income tax is a refund", () => {
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("100000", "0", "140"), paidTowardsYear: dec("30000") });
    expect([ir4.boxes["30J"], ir4.residual, ir4.boxes["30L"], ir4.outcome]).toEqual(["27860.00", "debit", "2140.00", "refund"]);
  });

  it("ITX52 losses brought forward use up the income; the credits come back", () => {
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("50000", "80000", "140"), paidTowardsYear: dec("0") });
    expect([ir4.boxes["25"], ir4.boxes["26A"], ir4.boxes["26B"], ir4.boxes["27"], ir4.boxes["29"], ir4.boxes["30B"]]).toEqual(["50000.00", "80000.00", "50000.00", "0.00", "0.00", "0.00"]);
    expect([ir4.boxes["30J"], ir4.residual, ir4.boxes["30L"], ir4.outcome]).toEqual(["140.00", "credit", "140.00", "refund"]);
  });

  it("ITX53 a loss year: no tax, and provisional tax paid is refunded", () => {
    const ir4 = ir4Return({ incomeYear: 2026, workpaper: paper("-12000"), paidTowardsYear: dec("5000") });
    expect([ir4.boxes["20B"], ir4.boxes["29"], ir4.boxes["30A"], ir4.boxes["30B"], ir4.boxes["30J"], ir4.residual, ir4.boxes["30L"], ir4.outcome]).toEqual([
      "-12000.00", "-12000.00", "-12000.00", "0.00", "0.00", "credit", "5000.00", "refund",
    ]);
  });
});
