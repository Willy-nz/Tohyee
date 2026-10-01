import { describe, expect, it } from "vitest";
import { addMoney, lineFigures, monthlyKiwiSaver, monthlyWages, rateForMonth, splitMonth, type WorkforceLineMaths } from "@/lib/payroll/workforce-figures";

/**
 * Workforce budget maths: examples WB1 and WB2 in docs/ACCOUNTING-EXAMPLES.md
 * ("Workforce budgets"), decisions 114-118.
 */
const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];

const hemi: WorkforceLineMaths = {
  payBasis: "salary",
  fte: "1",
  hoursPerWeek: null,
  rates: [
    { fromMonth: "2026-10", rate: "70000.00" },
    { fromMonth: "2027-01", rate: "73500.00" },
  ],
  kiwiSaverRate: "3.5",
  startMonth: "2026-10",
  endMonth: null,
};
const kiri: WorkforceLineMaths = { ...hemi, rates: [{ fromMonth: "2026-10", rate: "52000.00" }], kiwiSaverRate: "0" };
const sione: WorkforceLineMaths = { ...hemi, payBasis: "hourly", fte: null, hoursPerWeek: "32", rates: [{ fromMonth: "2026-10", rate: "22.50" }] };
const barista: WorkforceLineMaths = {
  payBasis: "hourly",
  fte: null,
  hoursPerWeek: "25",
  rates: [{ fromMonth: "2027-01", rate: "24.00" }],
  kiwiSaverRate: "3.5",
  startMonth: "2027-01",
  endMonth: "2027-03",
};

describe("workforce budget lines (WB1)", () => {
  it("works out each month's wages, half up, and KiwiSaver, truncated", () => {
    expect(monthlyWages(hemi, "70000.00")).toBe("5833.33");
    expect(monthlyKiwiSaver("5833.33", "3.5")).toBe("204.16");
    expect(monthlyKiwiSaver("6125.00", "3.5")).toBe("214.37");
    expect(monthlyWages(sione, "22.50")).toBe("3120.00");
    expect(monthlyWages(barista, "24.00")).toBe("2600.00");
    expect(monthlyWages({ payBasis: "salary", fte: "0.5", hoursPerWeek: null }, "60000.00")).toBe("2500.00");
    expect(rateForMonth(hemi.rates, "2026-12")).toBe("70000.00");
    expect(rateForMonth(hemi.rates, "2027-01")).toBe("73500.00");
    expect(rateForMonth(barista.rates, "2026-12")).toBeNull();
  });

  it("gives each line's months and the totals", () => {
    const all = [hemi, kiri, sione, barista].map((line) => lineFigures(line, months));
    expect(all[0].map((m) => m.wages)).toEqual(["5833.33", "5833.33", "5833.33", "6125.00", "6125.00", "6125.00"]);
    expect(all[1][0]).toEqual({ month: "2026-10", wages: "4333.33", kiwiSaver: "0.00" });
    expect(all[2][0]).toEqual({ month: "2026-10", wages: "3120.00", kiwiSaver: "109.20" });
    expect(all[3].map((m) => m.wages)).toEqual(["0.00", "0.00", "0.00", "2600.00", "2600.00", "2600.00"]);
    expect(all[3][3].kiwiSaver).toBe("91.00");
    const monthTotal = (index: number, key: "wages" | "kiwiSaver") => addMoney(all.map((line) => line[index][key]));
    expect(monthTotal(0, "wages")).toBe("13286.66");
    expect(monthTotal(3, "wages")).toBe("16178.33");
    expect(monthTotal(0, "kiwiSaver")).toBe("313.36");
    expect(monthTotal(3, "kiwiSaver")).toBe("414.57");
    expect(addMoney(all.flatMap((line) => line.map((m) => m.wages)))).toBe("88394.97");
    expect(addMoney(all.flatMap((line) => line.map((m) => m.kiwiSaver)))).toBe("2183.79");
  });
});

describe("splitting by Department (WB2)", () => {
  it("splits wages and KiwiSaver each with splitByPercentages", () => {
    expect(splitMonth({ month: "2026-10", wages: "5833.33", kiwiSaver: "204.16" }, ["60", "40"])).toEqual([
      { wages: "3500.00", kiwiSaver: "122.50" },
      { wages: "2333.33", kiwiSaver: "81.66" },
    ]);
    expect(splitMonth({ month: "2027-01", wages: "6125.00", kiwiSaver: "214.37" }, ["60", "40"])).toEqual([
      { wages: "3675.00", kiwiSaver: "128.62" },
      { wages: "2450.00", kiwiSaver: "85.75" },
    ]);
    expect(splitMonth({ month: "2027-01", wages: "2600.00", kiwiSaver: "91.00" }, ["50", "50"])).toEqual([
      { wages: "1300.00", kiwiSaver: "45.50" },
      { wages: "1300.00", kiwiSaver: "45.50" },
    ]);
  });
});
