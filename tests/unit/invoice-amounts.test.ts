import { describe, expect, it } from "vitest";
import {
  calculateInvoice,
  creditNoteCreditStatus,
  type InvoiceLineInput,
  invoicePaymentStatus,
} from "@/lib/invoices/amounts";

const GST_15 = "0.15";
const ZERO_RATED = "0";

const line = (quantity: string, unitPrice: string, taxRate = GST_15): InvoiceLineInput => ({
  quantity,
  unitPrice,
  taxRate,
});

describe("invoice amounts (worked examples)", () => {
  it("I1: exclusive 2 x 50.00 at 15% -> net 100.00, GST 15.00, total 115.00", () => {
    const result = calculateInvoice("exclusive", [line("2", "50.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "100.00", netAmount: "100.00", taxAmount: "15.00" }]);
    expect(result).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
  });

  it("I2: inclusive 1 x 115.00 at 15% -> net 100.00, GST 15.00, total 115.00", () => {
    const result = calculateInvoice("inclusive", [line("1", "115.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "115.00", netAmount: "100.00", taxAmount: "15.00" }]);
    expect(result).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
  });

  it("I3: exclusive, three lines of 1 x 3.33 -> GST 0.50 a line (0.4995 rounds up), GST 1.50, total 11.49", () => {
    const result = calculateInvoice("exclusive", [line("1", "3.33"), line("1", "3.33"), line("1", "3.33")], 2);
    expect(result.lines.map((entry) => entry.taxAmount)).toEqual(["0.50", "0.50", "0.50"]);
    expect(result).toMatchObject({ subtotal: "9.99", taxTotal: "1.50", total: "11.49" });
  });

  it("I4: inclusive 1 x 10.00 at 15% -> GST 10.00 x 3/23 = 1.3043 -> 1.30; net 8.70", () => {
    const result = calculateInvoice("inclusive", [line("1", "10.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "10.00", netAmount: "8.70", taxAmount: "1.30" }]);
    expect(result).toMatchObject({ subtotal: "8.70", taxTotal: "1.30", total: "10.00" });
  });

  it("I5: 100.00 exclusive at standard 15% + 50.00 zero-rated -> GST 15.00, total 165.00", () => {
    const result = calculateInvoice("exclusive", [line("1", "100.00"), line("1", "50.00", ZERO_RATED)], 2);
    expect(result.lines.map((entry) => [entry.netAmount, entry.taxAmount])).toEqual([
      ["100.00", "15.00"],
      ["50.00", "0.00"],
    ]);
    expect(result).toMatchObject({ subtotal: "150.00", taxTotal: "15.00", total: "165.00" });
  });

  it("I6: no tax 1 x 80.00 -> total 80.00 and no GST, whatever rate is passed", () => {
    const result = calculateInvoice("no_tax", [line("1", "80.00", GST_15)], 2);
    expect(result.lines).toEqual([{ lineAmount: "80.00", netAmount: "80.00", taxAmount: "0.00" }]);
    expect(result).toMatchObject({ subtotal: "80.00", taxTotal: "0.00", total: "80.00" });
  });
});

/** Bills use the same maths as invoices (docs/ACCOUNTING-EXAMPLES.md, "Bills"). */
describe("bill amounts (worked examples)", () => {
  const EXEMPT = "0";

  it("B1: exclusive 1 x 200.00 at 15% -> net 200.00, GST 30.00, total 230.00", () => {
    const result = calculateInvoice("exclusive", [line("1", "200.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "200.00", netAmount: "200.00", taxAmount: "30.00" }]);
    expect(result).toMatchObject({ subtotal: "200.00", taxTotal: "30.00", total: "230.00" });
  });

  it("B2: inclusive 1 x 46.00 at 15% -> GST 46.00 x 3/23 = 6.00; net 40.00; total 46.00", () => {
    const result = calculateInvoice("inclusive", [line("1", "46.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "46.00", netAmount: "40.00", taxAmount: "6.00" }]);
    expect(result).toMatchObject({ subtotal: "40.00", taxTotal: "6.00", total: "46.00" });
  });

  it("B3: exclusive, three lines of 1 x 3.33 -> GST 0.50 a line, GST 1.50, total 11.49 (same as I3)", () => {
    const result = calculateInvoice("exclusive", [line("1", "3.33"), line("1", "3.33"), line("1", "3.33")], 2);
    expect(result.lines.map((entry) => entry.taxAmount)).toEqual(["0.50", "0.50", "0.50"]);
    expect(result).toMatchObject({ subtotal: "9.99", taxTotal: "1.50", total: "11.49" });
  });

  it("B4: 100.00 exclusive at standard 15% + 20.00 exempt -> GST 15.00, total 135.00", () => {
    const result = calculateInvoice("exclusive", [line("1", "100.00"), line("1", "20.00", EXEMPT)], 2);
    expect(result.lines.map((entry) => [entry.netAmount, entry.taxAmount])).toEqual([
      ["100.00", "15.00"],
      ["20.00", "0.00"],
    ]);
    expect(result).toMatchObject({ subtotal: "120.00", taxTotal: "15.00", total: "135.00" });
  });
});

describe("invoice line rounding", () => {
  it("rounds quantity x unit price once to cents, half away from zero", () => {
    // 3 x 3.3333 = 9.9999 -> 10.00 (not 3 x 3.33 = 9.99); 1.5 x 0.3333 = 0.49995 -> 0.50.
    const result = calculateInvoice("no_tax", [line("3", "3.3333"), line("1.5", "0.3333")], 2);
    expect(result.lines.map((entry) => entry.lineAmount)).toEqual(["10.00", "0.50"]);
    expect(result.total).toBe("10.50");
  });

  it("works out GST from the rounded line amount", () => {
    // 1 x 3.3651 -> 3.37; GST 3.37 x 0.15 = 0.5055 -> 0.51 (3.3651 x 0.15 = 0.504765 would give 0.50).
    const result = calculateInvoice("exclusive", [line("1", "3.3651")], 2);
    expect(result.lines).toEqual([{ lineAmount: "3.37", netAmount: "3.37", taxAmount: "0.51" }]);
    expect(result.total).toBe("3.88");
  });

  it("gives zero-rated lines no GST in inclusive mode too", () => {
    const result = calculateInvoice("inclusive", [line("1", "115.00"), line("2", "25.00", ZERO_RATED)], 2);
    expect(result.lines.map((entry) => [entry.netAmount, entry.taxAmount])).toEqual([
      ["100.00", "15.00"],
      ["50.00", "0.00"],
    ]);
    expect(result).toMatchObject({ subtotal: "150.00", taxTotal: "15.00", total: "165.00" });
  });

  it("uses the currency's minor units (none for JPY)", () => {
    const result = calculateInvoice("exclusive", [line("1", "1005")], 0);
    // 1005 x 0.15 = 150.75 -> 151
    expect(result).toMatchObject({ subtotal: "1005", taxTotal: "151", total: "1156" });
  });
});

describe("invoice paid status (worked examples)", () => {
  it("CP1: 115.00 paid against a 115.00 invoice leaves 0.00 due, so it's paid", () => {
    expect(invoicePaymentStatus("115.00", "115.00", 2)).toEqual({
      amountPaid: "115.00",
      amountDue: "0.00",
      paidStatus: "paid",
    });
  });

  it("CP2: nothing paid is unpaid; 50.00 then 65.00 is part paid with 65.00 due, then paid", () => {
    expect(invoicePaymentStatus("115.00", "0", 2)).toEqual({ amountPaid: "0.00", amountDue: "115.00", paidStatus: "unpaid" });
    expect(invoicePaymentStatus("115.00", "50.00", 2)).toEqual({
      amountPaid: "50.00",
      amountDue: "65.00",
      paidStatus: "part_paid",
    });
    expect(invoicePaymentStatus("115.00", "115.00", 2).paidStatus).toBe("paid");
  });

  it("CP4: voiding the 65.00 payment leaves 50.00 paid, so 65.00 is due again and it's part paid", () => {
    expect(invoicePaymentStatus("115.00", "50.00", 2)).toEqual({
      amountPaid: "50.00",
      amountDue: "65.00",
      paidStatus: "part_paid",
    });
  });

  it("works to the cent and in the currency's minor units", () => {
    expect(invoicePaymentStatus("11.49", "11.48", 2)).toEqual({ amountPaid: "11.48", amountDue: "0.01", paidStatus: "part_paid" });
    expect(invoicePaymentStatus("1156", "156", 0)).toEqual({ amountPaid: "156", amountDue: "1000", paidStatus: "part_paid" });
  });
});

describe("credit note amounts (worked examples)", () => {
  it("CN2: exclusive 1 x 20.00 at 15% -> net 20.00, GST 3.00, total 23.00", () => {
    const result = calculateInvoice("exclusive", [line("1", "20.00")], 2);
    expect(result).toMatchObject({ subtotal: "20.00", taxTotal: "3.00", total: "23.00" });
  });

  it("CN10: inclusive 1 x 15.00 at 15% -> GST 1.96, net 13.04, total 15.00 (same maths as invoices)", () => {
    const result = calculateInvoice("inclusive", [line("1", "15.00")], 2);
    expect(result.lines).toEqual([{ lineAmount: "15.00", netAmount: "13.04", taxAmount: "1.96" }]);
    expect(result).toMatchObject({ subtotal: "13.04", taxTotal: "1.96", total: "15.00" });
  });

  it("CN2-CN4, CN7, CN8: remaining credit is the total less active applications and refunds", () => {
    expect(creditNoteCreditStatus("23.00", "0", "0", 2)).toEqual({
      amountApplied: "0.00",
      amountRefunded: "0.00",
      remainingCredit: "23.00",
      creditStatus: "open",
    });
    expect(creditNoteCreditStatus("23.00", "23.00", "0", 2)).toMatchObject({ remainingCredit: "0.00", creditStatus: "used" });
    expect(creditNoteCreditStatus("115.00", "100.00", "0", 2)).toMatchObject({
      remainingCredit: "15.00",
      creditStatus: "part_used",
    });
    expect(creditNoteCreditStatus("115.00", "100.00", "15.00", 2)).toEqual({
      amountApplied: "100.00",
      amountRefunded: "15.00",
      remainingCredit: "0.00",
      creditStatus: "used",
    });
  });
});

describe("invoice paid status with credit applied (worked examples)", () => {
  it("CN3: 23.00 credited against a 115.00 invoice leaves 92.00 due, part paid", () => {
    expect(invoicePaymentStatus("115.00", "0", 2, "23.00")).toEqual({
      amountPaid: "0.00",
      amountDue: "92.00",
      paidStatus: "part_paid",
    });
  });

  it("CN4, CN6: credit and payments together settle the invoice", () => {
    expect(invoicePaymentStatus("80.00", "0", 2, "80.00")).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
    expect(invoicePaymentStatus("115.00", "92.00", 2, "23.00")).toMatchObject({ amountDue: "0.00", paidStatus: "paid" });
  });
});
