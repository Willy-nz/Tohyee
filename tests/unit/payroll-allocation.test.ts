import { describe, expect, it } from "vitest";
import { dec, sum, toFixedString, toPlainString, truncate } from "@/lib/money/decimal";
import { assertTotalsOneHundred, parseAllocationPercentage, splitByPercentages } from "@/lib/payroll/allocation-split";

describe("payroll cost allocation split (PE3-PE5)", () => {
  it("PE3: a 60/40 split of $1,234.57 gives the left-over cent to the line with the most cut off", () => {
    expect(splitByPercentages("1234.57", ["60", "40"])).toEqual(["740.74", "493.83"]);
  });

  it("PE3: a negative amount mirrors the positive split exactly", () => {
    expect(splitByPercentages("-1234.57", ["60", "40"])).toEqual(["-740.74", "-493.83"]);
  });

  it("PE4: three lines of 33.33/33.33/33.34 of $10.00 give the cent to the third line", () => {
    expect(splitByPercentages("10.00", ["33.33", "33.33", "33.34"])).toEqual(["3.33", "3.33", "3.34"]);
  });

  it("PE4: a tie goes to the earlier line, so 50/50 of one cent is 0.01 and 0.00", () => {
    expect(splitByPercentages("0.01", ["50", "50"])).toEqual(["0.01", "0.00"]);
  });

  it("PE4: an exact split leaves nothing over", () => {
    expect(splitByPercentages("100.00", ["33.33", "33.33", "33.34"])).toEqual(["33.33", "33.33", "33.34"]);
    expect(splitByPercentages("0", ["60", "40"])).toEqual(["0.00", "0.00"]);
  });

  it("PE3-PE4: the parts always add back to the whole", () => {
    const percentages = ["12.5", "0.01", "37.49", "25", "25"];
    for (const amount of ["0.01", "0.07", "1", "99.99", "1234.57", "98765.43", "-0.03", "-1234.57"]) {
      const parts = splitByPercentages(amount, percentages);
      expect(parts).toHaveLength(percentages.length);
      expect(toFixedString(sum(parts.map(dec)), 2)).toBe(toFixedString(dec(amount), 2));
    }
  });

  it("PE5: lines must total exactly 100.00%", () => {
    expect(() => assertTotalsOneHundred(["60", "30"])).toThrow("The allocation lines total 90.00%. They must total exactly 100.00%.");
    expect(() => assertTotalsOneHundred(["60", "50"])).toThrow("The allocation lines total 110.00%. They must total exactly 100.00%.");
    expect(() => assertTotalsOneHundred([])).toThrow(/at least one line/i);
    expect(() => assertTotalsOneHundred(["99.99", "0.01"])).not.toThrow();
    expect(() => splitByPercentages("10", ["60", "30"])).toThrow(/total 90.00%/);
  });

  it("PE5: a line's percentage is more than 0 with at most 2 decimal places", () => {
    expect(parseAllocationPercentage("60", "Line 1")).toBe("60");
    expect(parseAllocationPercentage("33.30", "Line 1")).toBe("33.3");
    expect(() => parseAllocationPercentage("0", "Line 1")).toThrow(/must not be zero/i);
    expect(() => parseAllocationPercentage("-5", "Line 1")).toThrow(/can't be negative/i);
    expect(() => parseAllocationPercentage("33.333", "Line 1")).toThrow(/at most 2 decimal places/i);
    expect(() => parseAllocationPercentage("100.01", "Line 1")).toThrow(/can't be more than 100%/i);
  });

  it("refuses amounts with more than 2 decimal places", () => {
    expect(() => splitByPercentages("1.234", ["100"])).toThrow(/at most 2 decimal places/i);
  });
});

describe("truncate", () => {
  it("cuts towards zero", () => {
    expect(toPlainString(truncate(dec("740.742"), 2))).toBe("740.74");
    expect(toPlainString(truncate(dec("493.828"), 2))).toBe("493.82");
    expect(toPlainString(truncate(dec("-493.828"), 2))).toBe("-493.82");
    expect(toPlainString(truncate(dec("3"), 2))).toBe("3");
  });
});
