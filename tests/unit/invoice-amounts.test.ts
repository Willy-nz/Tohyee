import { describe, expect, it } from "vitest";
import { calculateInvoice, type InvoiceLineInput, invoicePaymentStatus } from "@/lib/invoices/amounts";

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
