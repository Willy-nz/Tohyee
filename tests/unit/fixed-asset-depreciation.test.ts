import { describe, expect, it } from "vitest";
import {
  type AssetBasis,
  type ChargedSegment,
  disposalFigures,
  firstDepreciationMonth,
  isMonthEnd,
  lastMonthBeforeDisposal,
  monthEnd,
  planDepreciation,
} from "@/lib/fixed-assets/depreciation";
import { dec, sum, toFixedString } from "@/lib/money/decimal";

/** Pure depreciation maths for examples FA3-FA10 in docs/ACCOUNTING-EXAMPLES.md ("Fixed assets"). March year end. */
const MARCH = 3;

const laptop: AssetBasis = { method: "dv", rate: "50", cost: "2000.00", residualValue: "0", openingAccumulated: "0", firstMonth: "2026-05" };
const ute: AssetBasis = { method: "dv", rate: "30", cost: "30000.00", residualValue: "0", openingAccumulated: "0", firstMonth: "2026-06" };
const desk: AssetBasis = { method: "sl", rate: "20", cost: "1200.00", residualValue: "0", openingAccumulated: "0", firstMonth: "2026-04" };
const printer: AssetBasis = { method: "dv", rate: "40", cost: "1500.00", residualValue: "0", openingAccumulated: "900.00", firstMonth: "2026-04" };

function charge(basis: AssetBasis, through: string, charged: ChargedSegment[] = []) {
  return planDepreciation(basis, charged, through, MARCH, 2);
}

/** Runs month by month, like a depreciation run each month end. */
function runMonthly(basis: AssetBasis, months: string[]): string[] {
  const charged: ChargedSegment[] = [];
  return months.map((month) => {
    const planned = charge(basis, month, charged);
    charged.push(...planned);
    return planned.map((segment) => segment.amount).join("+") || "0";
  });
}

describe("fixed asset depreciation maths", () => {
  it("FA3/FA4: DV and SL charged by whole months, rounded once per run so the year adds up", () => {
    expect(runMonthly(laptop, ["2026-05", "2026-06"])).toEqual(["83.33", "83.34"]);
    expect(runMonthly(desk, ["2026-05", "2026-06"])).toEqual(["40.00", "20.00"]);
    // Opening accumulated depreciation of 900.00 at 31 Mar 2026: DV on the 600.00 book value.
    expect(runMonthly(printer, ["2026-05", "2026-06"])).toEqual(["40.00", "20.00"]);
    expect(runMonthly(ute, ["2026-05", "2026-06"])).toEqual(["0", "750.00"]);
    const may = charge(laptop, "2026-05")[0];
    expect(may).toEqual({ financialYearStart: "2026-04-01", fromMonth: "2026-05", toMonth: "2026-05", months: 1, amount: "83.33" });
  });

  it("FA6: a two-month run charges the same as two monthly runs, and a late asset catches up", () => {
    const charged = [...charge(laptop, "2026-06")];
    expect(charged.map((s) => s.amount)).toEqual(["166.67"]);
    expect(charge(laptop, "2026-08", charged).map((s) => [s.fromMonth, s.toMonth, s.months, s.amount])).toEqual([["2026-07", "2026-08", 2, "166.66"]]);
    expect(runMonthly(laptop, ["2026-05", "2026-06", "2026-07", "2026-08"])).toEqual(["83.33", "83.34", "83.33", "83.33"]);
    expect(charge(ute, "2026-08", charge(ute, "2026-06")).map((s) => s.amount)).toEqual(["1500.00"]);
    // A monitor bought 20 May 2026, registered after the June run: the August run charges May to August.
    const monitor: AssetBasis = { ...laptop, cost: "600.00" };
    expect(charge(monitor, "2026-08").map((s) => [s.fromMonth, s.months, s.amount])).toEqual([["2026-05", 4, "100.00"]]);
  });

  it("FA3: DV starts each financial year from the book value at its start; a run across a year end rounds per year", () => {
    expect(charge(printer, "2027-04").map((s) => [s.financialYearStart, s.fromMonth, s.toMonth, s.amount])).toEqual([
      ["2026-04-01", "2026-04", "2027-03", "240.00"],
      ["2027-04-01", "2027-04", "2027-04", "12.00"],
    ]);
    const monthly = runMonthly(printer, ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"]);
    expect(toFixedString(sum(monthly.slice(0, 12).map((amount) => dec(amount))), 2)).toBe("240.00");
    expect(monthly[12]).toBe("12.00");
  });

  it("FA3: straight line never takes the book value below the residual value", () => {
    const tool: AssetBasis = { method: "sl", rate: "50", cost: "1000.00", residualValue: "400.00", openingAccumulated: "0", firstMonth: "2026-04" };
    expect(runMonthly(tool, ["2027-03", "2027-05", "2027-06", "2027-07"])).toEqual(["500.00", "83.33", "16.67", "0.00"]);
    const land: AssetBasis = { ...tool, method: "none", rate: null };
    expect(charge(land, "2027-03")).toEqual([]);
  });

  it("FA7/FA8: the first-month and disposal-month settings", () => {
    expect(firstDepreciationMonth("2026-06-20", null, "full_month")).toBe("2026-06");
    expect(firstDepreciationMonth("2026-06-20", null, "next_month")).toBe("2026-07");
    expect(firstDepreciationMonth("2023-07-01", "2026-03-31", "full_month")).toBe("2026-04");
    expect(lastMonthBeforeDisposal("2026-09-15", "exclude")).toBe("2026-08");
    expect(lastMonthBeforeDisposal("2026-09-15", "include")).toBe("2026-09");
    expect(runMonthly({ ...ute, firstMonth: "2026-07" }, ["2026-06", "2026-07"])).toEqual(["0", "750.00"]);
    expect([monthEnd("2026-02"), monthEnd("2028-02"), isMonthEnd("2026-06-30"), isMonthEnd("2026-07-15")]).toEqual(["2026-02-28", "2028-02-29", true, false]);
  });

  it("FA8-FA10: a disposal's gain or loss", () => {
    expect(disposalFigures("30000.00", "2250.00", "25000.00", 2)).toMatchObject({ bookValue: "27750.00", loss: "2750.00", depreciationRecovered: "0.00", capitalGain: "0.00" });
    expect(disposalFigures("1200.00", "100.00", "1300.00", 2)).toMatchObject({ bookValue: "1100.00", loss: "0.00", depreciationRecovered: "100.00", capitalGain: "100.00" });
    expect(disposalFigures("1500.00", "1000.00", "700.00", 2)).toMatchObject({ bookValue: "500.00", depreciationRecovered: "200.00", capitalGain: "0.00" });
    expect(disposalFigures("2000.00", "416.67", "0", 2)).toMatchObject({ bookValue: "1583.33", loss: "1583.33" });
  });
});
