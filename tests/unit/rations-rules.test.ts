import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { rationsAdjustmentPosting } from "@/lib/livestock/rations-rules";

/** The owner's rations as one yearly adjustment (RAT5-RAT7; Jess, 20 October 2026, not yet reviewed). */
describe("rations yearly adjustment", () => {
  it("RAT5 500.00 with no GST: Dr drawings 500.00, Cr rations income 500.00", () => {
    expect(rationsAdjustmentPosting({ amount: dec("500"), gstApplies: false, includesGst: false })).toEqual({ drawings: "500.00", income: "500.00", gst: "0.00" });
  });

  it("RAT6 1,100.00 excluding GST: Dr drawings 1,265.00, Cr income 1,100.00, Cr GST 165.00", () => {
    expect(rationsAdjustmentPosting({ amount: dec("1100"), gstApplies: true, includesGst: false })).toEqual({ drawings: "1265.00", income: "1100.00", gst: "165.00" });
  });

  it("RAT7 1,100.00 including GST: GST 143.48 and income 956.52", () => {
    expect(rationsAdjustmentPosting({ amount: dec("1100"), gstApplies: true, includesGst: true })).toEqual({ drawings: "1100.00", income: "956.52", gst: "143.48" });
  });
});
