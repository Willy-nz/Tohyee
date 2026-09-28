import { describe, expect, it } from "vitest";
import {
  basisChangeAdjustment,
  calculateGstBoxes,
  changedGstBoxes,
  countsWhenSettled,
  gstInOutstanding,
  settlementShares,
  gstPeriodEnd,
  parseGstAdjustments,
  parseGstPeriod,
} from "@/lib/reports/gst-boxes";

const noAdjustments = { adjustments: [] };

/** docs/ACCOUNTING-EXAMPLES.md, "GST return": the pure box maths and periods. */
describe("GST return maths", () => {
  it("G1: I1 (115.00) and B1 (230.00) give a refund of 15.00", () => {
    const figures = calculateGstBoxes({
      box5: "115.00",
      box6: "0",
      box11: "230.00",
      salesGst: "15.00",
      purchasesGst: "30.00",
      ...noAdjustments,
    });
    expect(figures.boxes).toEqual({
      box5: "115.00",
      box6: "0.00",
      box7: "115.00",
      box8: "15.00",
      box9: "0.00",
      box10: "15.00",
      box11: "230.00",
      box12: "30.00",
      box13: "0.00",
      box14: "30.00",
      box15: "-15.00",
    });
    expect(figures.gstOnTransactions).toEqual({
      sales: "15.00",
      purchases: "30.00",
      salesDifference: "0.00",
      purchasesDifference: "0.00",
    });
  });

  it("G2: zero-rated supplies are in Box 5 and Box 6, so they carry no GST", () => {
    const { boxes } = calculateGstBoxes({
      box5: "165.00",
      box6: "50.00",
      box11: "0",
      salesGst: "15.00",
      purchasesGst: "0",
      ...noAdjustments,
    });
    expect(boxes).toMatchObject({ box5: "165.00", box6: "50.00", box7: "115.00", box8: "15.00" });
  });

  it("G6: Box 8 is rounded once from Box 7, so it can differ from the lines' GST by a cent", () => {
    const figures = calculateGstBoxes({
      box5: "30.00",
      box6: "0",
      box11: "0",
      salesGst: "3.90",
      purchasesGst: "0",
      ...noAdjustments,
    });
    expect(figures.boxes.box8).toBe("3.91");
    expect(figures.gstOnTransactions).toMatchObject({ sales: "3.90", salesDifference: "0.01" });
  });

  it("G5: boxes can be negative, and 3/23 rounds half away from zero on both sides", () => {
    const { boxes } = calculateGstBoxes({
      box5: "-115.00",
      box6: "0",
      box11: "-10.00",
      salesGst: "-15.00",
      purchasesGst: "-1.30",
      ...noAdjustments,
    });
    // -10.00 x 3 / 23 = -1.3043... -> -1.30
    expect(boxes).toMatchObject({ box5: "-115.00", box8: "-15.00", box11: "-10.00", box12: "-1.30", box15: "-13.70" });
  });

  it("G7: Box 9 and Box 13 adjustments feed Box 10, Box 14 and Box 15", () => {
    const adjustments = parseGstAdjustments([
      { box: "9", description: "Bad debt recovered", amount: "23" },
      { box: 13, description: "Bad debt written off", amount: "11.5" },
    ]);
    expect(adjustments).toEqual([
      { box: "9", description: "Bad debt recovered", amount: "23.00" },
      { box: "13", description: "Bad debt written off", amount: "11.50" },
    ]);
    const { boxes } = calculateGstBoxes({
      box5: "115.00",
      box6: "0",
      box11: "230.00",
      salesGst: "15.00",
      purchasesGst: "30.00",
      adjustments,
    });
    expect(boxes).toMatchObject({ box9: "23.00", box10: "38.00", box13: "11.50", box14: "41.50", box15: "-3.50" });
  });

  it("G7: adjustments of 0.00, -1.00 or 1.001, or without a description or box, are refused", () => {
    for (const [amount, message] of [
      ["0.00", /must not be zero/],
      ["-1.00", /can't be negative/],
      ["1.001", /at most 2 decimal places/],
      ["", /is required/],
    ] as const) {
      expect(() => parseGstAdjustments([{ box: "9", description: "x", amount }])).toThrow(message);
    }
    expect(() => parseGstAdjustments([{ box: "9", description: " ", amount: "1" }])).toThrow(/description is required/);
    expect(() => parseGstAdjustments([{ box: "10", description: "x", amount: "1" }])).toThrow(/box must be 9/);
    expect(() => parseGstAdjustments("nope")).toThrow(/must be a list/);
    expect(parseGstAdjustments(undefined)).toEqual([]);
  });

  it("G9: a return covers 1, 2 or 6 whole calendar months", () => {
    expect(parseGstPeriod("2026-04-01", "2026-04-30")).toEqual({ periodStart: "2026-04-01", periodEnd: "2026-04-30", months: 1 });
    expect(parseGstPeriod("2026-04-01", "2026-05-31").months).toBe(2);
    expect(parseGstPeriod("2026-04-01", "2026-09-30").months).toBe(6);
    expect(parseGstPeriod("2026-11-01", "2027-04-30").months).toBe(6);
    expect(() => parseGstPeriod("2026-04-02", "2026-05-31")).toThrow(/starts on the 1st/);
    expect(() => parseGstPeriod("2026-04-01", "2026-06-30")).toThrow(/1, 2 or 6 whole months, not 3/);
    expect(() => parseGstPeriod("2026-04-01", "2026-05-15")).toThrow(/ends on the last day of a month/);
    expect(() => parseGstPeriod("2026-04-01", "2026-03-31")).toThrow(/after periodStart/);
    expect(() => parseGstPeriod("2026-04-01", "2026-04-31")).toThrow(/not a real date/);
  });

  it("G9: period ends, including February in a leap year and across a year end", () => {
    expect(gstPeriodEnd("2028-02-01", 1)).toBe("2028-02-29");
    expect(gstPeriodEnd("2026-02-01", 1)).toBe("2026-02-28");
    expect(gstPeriodEnd("2026-12-01", 2)).toBe("2027-01-31");
    expect(gstPeriodEnd("2026-04-01", 6)).toBe("2026-09-30");
  });

  it("G8: changed boxes are listed with their filed and current amounts", () => {
    const filed = calculateGstBoxes({ box5: "115.00", box6: "0", box11: "230.00", salesGst: "15", purchasesGst: "30", ...noAdjustments });
    const current = calculateGstBoxes({ box5: "115.00", box6: "0", box11: "345.00", salesGst: "15", purchasesGst: "45", ...noAdjustments });
    expect(changedGstBoxes(filed.boxes, current.boxes)).toEqual([
      { box: "box11", filed: "230.00", current: "345.00" },
      { box: "box12", filed: "30.00", current: "45.00" },
      { box: "box14", filed: "30.00", current: "45.00" },
      { box: "box15", filed: "-15.00", current: "-30.00" },
    ]);
    expect(changedGstBoxes(filed.boxes, filed.boxes)).toEqual([]);
  });
});

/** docs/ACCOUNTING-EXAMPLES.md, "Payments and hybrid bases": shares and basis changes. */
describe("GST payments and hybrid bases maths", () => {
  it("G10-G18: which side counts when settled on each basis", () => {
    expect(countsWhenSettled("invoice", "sales")).toBe(false);
    expect(countsWhenSettled("invoice", "purchases")).toBe(false);
    expect(countsWhenSettled("payments", "sales")).toBe(true);
    expect(countsWhenSettled("payments", "purchases")).toBe(true);
    expect(countsWhenSettled("hybrid", "sales")).toBe(false);
    expect(countsWhenSettled("hybrid", "purchases")).toBe(true);
  });

  it("G11: I5 paid 82.50 splits in proportion", () => {
    const i5 = [
      { amount: "115.00", gst: "15.00" },
      { amount: "50.00", gst: "0.00" },
    ];
    expect(settlementShares(i5, "82.50", "165.00")).toEqual([
      { amount: "57.50", gst: "7.50" },
      { amount: "25.00", gst: "0.00" },
    ]);
    const figures = calculateGstBoxes({ box5: "82.50", box6: "25.00", box11: "0", salesGst: "7.50", purchasesGst: "0", ...noAdjustments });
    expect(figures.boxes.box7).toBe("57.50");
    expect(figures.boxes.box8).toBe("7.50");
    // Paid in full, a document's shares are its lines.
    expect(settlementShares(i5, "165.00", "165.00")).toEqual([
      { amount: "115.00", gst: "15.00" },
      { amount: "50.00", gst: "0.00" },
    ]);
  });

  it("G12: the leftover cent goes to the largest (first) line", () => {
    const lines = [
      { amount: "10.00", gst: "1.30" },
      { amount: "10.00", gst: "1.30" },
      { amount: "10.00", gst: "0.00" },
    ];
    const first = settlementShares(lines, "10.00", "30.00");
    expect(first).toEqual([
      { amount: "3.34", gst: "0.44" },
      { amount: "3.33", gst: "0.43" },
      { amount: "3.33", gst: "0.00" },
    ]);
    const figures = calculateGstBoxes({ box5: "10.00", box6: "3.33", box11: "0", salesGst: "0.87", purchasesGst: "0", ...noAdjustments });
    expect(figures.boxes.box7).toBe("6.67");
    expect(figures.boxes.box8).toBe("0.87");
    const rest = settlementShares(lines, "20.00", "30.00");
    expect(rest.map((share) => share.amount)).toEqual(["6.66", "6.67", "6.67"]);
    expect(rest.map((share) => share.gst)).toEqual(["0.86", "0.87", "0.00"]);
  });

  it("G20: GST in what's still owed", () => {
    expect(gstInOutstanding("115.00", "15.00", "115.00")).toBe("15.00");
    expect(gstInOutstanding("82.50", "15.00", "165.00")).toBe("7.50");
    expect(gstInOutstanding("-23.00", "3.00", "23.00")).toBe("-3.00");
  });

  it("G20, G21: the IR546 adjustment for each change of basis", () => {
    const at = { asAt: "2026-03-31", debtorsGst: "19.50", creditorsGst: "30.00" };
    expect(basisChangeAdjustment({ from: "invoice", to: "payments", ...at })).toEqual({
      box: "9",
      description: "Change of GST basis from invoice to payments at 31 Mar 2026: GST on debtors 19.50, GST on creditors 30.00",
      amount: "10.50",
    });
    const box = (from: "invoice" | "payments" | "hybrid", to: "invoice" | "payments" | "hybrid") => {
      const adjustment = basisChangeAdjustment({ from, to, ...at });
      return adjustment ? `${adjustment.box}:${adjustment.amount}` : null;
    };
    expect(box("payments", "invoice")).toBe("13:10.50");
    expect(box("invoice", "hybrid")).toBe("9:30.00");
    expect(box("payments", "hybrid")).toBe("9:19.50");
    expect(box("hybrid", "payments")).toBe("13:19.50");
    expect(box("hybrid", "invoice")).toBe("13:30.00");
    expect(box("invoice", "invoice")).toBeNull();
    expect(basisChangeAdjustment({ from: "payments", to: "hybrid", asAt: "2026-03-31", debtorsGst: "-3.00", creditorsGst: "0" })).toEqual({
      box: "13",
      description: "Change of GST basis from payments to hybrid at 31 Mar 2026: GST on debtors -3.00",
      amount: "3.00",
    });
    expect(basisChangeAdjustment({ from: "invoice", to: "payments", asAt: "2026-03-31", debtorsGst: "30.00", creditorsGst: "30.00" })).toBeNull();
  });
});
