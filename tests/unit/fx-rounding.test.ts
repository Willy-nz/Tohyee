import { describe, expect, it } from "vitest";
import { splitGain } from "@/lib/fx/documents";

/** How a settlement's difference splits into NetSuite's realised gain and rounding (MC31-MC38). */
describe("splitGain", () => {
  it("MC32: (1.60 - 1.50) x 10.05 = 1.005 -> 1.01 realised; the difference of 1.00 leaves -0.01 rounding", () => {
    expect(splitGain("1.00", "10.05", "1.60", "1.5")).toEqual({ gain: "1.00", realised: "1.01", rounding: "-0.01" });
  });

  it("MC4: the same rate is all rounding", () => {
    expect(splitGain("-0.01", "30.03", "1.5", "1.5")).toEqual({ gain: "-0.01", realised: "0.00", rounding: "-0.01" });
  });

  it("MC33: a loss rounds half away from zero (-1.005 -> -1.01)", () => {
    expect(splitGain("-1.00", "10.05", "1.5", "1.60")).toEqual({ gain: "-1.00", realised: "-1.01", rounding: "0.01" });
  });

  it("MC20: rates are used in full, not rounded", () => {
    expect(splitGain("2.99", "100.01", "1.65", "1.62")).toEqual({ gain: "2.99", realised: "3.00", rounding: "-0.01" });
    expect(splitGain("0.00", "1.00", "1.23456789", "1.23456788")).toEqual({ gain: "0.00", realised: "0.00", rounding: "0.00" });
  });
});
