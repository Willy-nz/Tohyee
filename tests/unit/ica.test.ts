import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { icaLedger, maxCredits } from "@/lib/tax/income/ica";

const move = (date: string, kind: Parameters<typeof icaLedger>[0][number]["kind"], amount: string, dividend: string | null = null, id = date) => ({
  id,
  date,
  kind,
  amount: dec(amount),
  dividend: dividend === null ? null : dec(dividend),
  description: null,
  createdByEmail: null,
});

describe("imputation credit account (ITX25-ITX28, from IR274, not yet reviewed)", () => {
  it("ITX27 credits on a dividend are at most 28/72", () => {
    expect(maxCredits(dec("7200"))).toEqual(dec("2800.00"));
    expect(maxCredits(dec("36000"))).toEqual(dec("14000.00"));
    expect(maxCredits(dec("100"))).toEqual(dec("38.89"));
  });

  it("ITX25, ITX26 the year's entries by date, with a running balance", () => {
    const ica = icaLedger(
      [
        move("2025-04-01", "opening", "5000"),
        move("2025-08-28", "tax_paid", "6183.80"),
        move("2025-10-31", "dividend_received", "280"),
        move("2025-12-15", "dividend_paid", "-2800", "7200"),
        move("2026-01-10", "refund", "-500"),
        move("2026-02-07", "tax_paid", "2000"),
        move("2026-03-31", "rwt_deducted", "140"),
        move("2026-04-01", "tax_paid", "999"),
      ],
      2026,
    );
    expect(ica.opening).toBe("0.00");
    expect(ica.rows.map((row) => [row.date, row.amount, row.balance])).toEqual([
      ["2025-04-01", "5000.00", "5000.00"],
      ["2025-08-28", "6183.80", "11183.80"],
      ["2025-10-31", "280.00", "11463.80"],
      ["2025-12-15", "-2800.00", "8663.80"],
      ["2026-01-10", "-500.00", "8163.80"],
      ["2026-02-07", "2000.00", "10163.80"],
      ["2026-03-31", "140.00", "10303.80"],
    ]);
    expect(ica.closing).toBe("10303.80");
    expect(ica.debitBalance).toBeNull();
    // ITX49: the IR4's imputation return boxes.
    expect(ica.ir4).toEqual({ "41": "5000.00", "42A": "8183.80", "42B": "140.00", "42C": "280.00", "42D": "0.00", "43A": "500.00", "43B": "2800.00", "43C": "0.00", "44B": "10303.80", "45": "0.00" });
    // The next year opens with the closing balance.
    expect(icaLedger([move("2025-04-01", "opening", "5000"), move("2026-01-10", "refund", "-500")], 2027).opening).toBe("4500.00");
  });

  it("ITX28 a debit balance at 31 March: further income tax and 10% penalty due 20 June", () => {
    const ica = icaLedger([move("2025-04-01", "opening", "9500"), move("2026-03-01", "dividend_paid", "-14000", "36000")], 2026);
    expect(ica.closing).toBe("-4500.00");
    expect([ica.ir4["41"], ica.ir4["43B"], ica.ir4["44B"], ica.ir4["45"]]).toEqual(["9500.00", "14000.00", "-4500.00", "450.00"]);
    expect(ica.debitBalance).toEqual({ furtherIncomeTax: "4500.00", penalty: "450.00", dueDate: "2026-06-20", onTimeBy: { date: "2026-06-22", holidaysChecked: true } });
  });

  it("ITX27 flags a dividend whose ratio differs from the year's first", () => {
    const ica = icaLedger([move("2025-06-01", "dividend_paid", "-2800", "7200", "a"), move("2025-12-01", "dividend_paid", "-1000", "7200", "b")], 2026);
    expect(ica.rows.map((row) => row.ratioDiffers)).toEqual([false, true]);
    expect(ica.notes.join(" ")).toContain("IR407");
  });
});
