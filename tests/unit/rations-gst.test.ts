import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { rationsPosting, supplyGst } from "@/lib/livestock/rations-gst-rules";

/** GST on the owner's rations (RAT1, RAT5-RAT10; as delegated, not yet reviewed by an accountant). */
describe("rations GST", () => {
  it("RAT5 a confirmed taxable supply at 1,100.00 excluding GST: Dr drawings 1,265.00, Cr income 1,100.00, Cr GST 165.00", () => {
    expect(rationsPosting({ value: dec("1100"), includesGst: false, status: "taxable_supply" })).toEqual({ drawings: "1265.00", income: "1100.00", gst: "165.00" });
  });

  it("RAT6 1,100.00 including GST: GST 143.48 and income 956.52", () => {
    const { net, gst } = supplyGst(dec("1100"), true);
    expect([net, gst].map((value) => `${value.units}/${value.scale}`)).toEqual(["95652/2", "14348/2"]);
    expect(rationsPosting({ value: dec("1100"), includesGst: true, status: "taxable_supply" })).toEqual({ drawings: "1100.00", income: "956.52", gst: "143.48" });
  });

  it("RAT1 unresolved, not registered or no adjustment: the value, and no GST", () => {
    for (const status of ["unresolved", "not_registered", "no_adjustment"] as const) {
      expect(rationsPosting({ value: dec("1100"), includesGst: false, status })).toEqual({ drawings: "1100.00", income: "1100.00", gst: "0.00" });
    }
  });

  it("RAT7 a change-in-use adjustment posts the reviewed GST, and needs one", () => {
    expect(rationsPosting({ value: dec("1100"), includesGst: false, status: "change_in_use", reviewedGst: dec("120") })).toEqual({ drawings: "1220.00", income: "1100.00", gst: "120.00" });
    expect(() => rationsPosting({ value: dec("1100"), includesGst: false, status: "change_in_use" })).toThrow("reviewed GST");
  });
});
