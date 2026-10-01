import { describe, expect, it } from "vitest";
import { dec, sum, toFixedString } from "@/lib/money/decimal";
import { splitByPercentages } from "@/lib/payroll/allocation-split";
import {
  coveredHoursOnly,
  isMonday,
  parseTimesheetHours,
  percentageOfWeight,
  splitByWeights,
  timesheetLateness,
  timesheetWeights,
  weekDays,
  weekStartOf,
  weightShareRoundedDown,
} from "@/lib/payroll/timesheet-split";

/** Pure timesheet rules: examples TS2, TS3 and TS5-TS8 in docs/ACCOUNTING-EXAMPLES.md ("Timesheets"). */
describe("timesheets (TS2, TS3, TS5-TS8)", () => {
  it("TS2: a week runs Monday to Sunday (decision 92)", () => {
    expect(isMonday("2026-07-06")).toBe(true);
    expect(isMonday("2026-07-07")).toBe(false);
    expect(weekStartOf("2026-07-12")).toBe("2026-07-06");
    expect(weekStartOf("2026-07-06")).toBe("2026-07-06");
    expect(weekStartOf("2026-07-13")).toBe("2026-07-13");
    expect(weekDays("2026-07-06")).toEqual(["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]);
  });

  it("TS2, TS11: hours are decimals to 2 places, more than 0 and at most 24", () => {
    expect(parseTimesheetHours("8", "Mon")).toBe("8.00");
    expect(parseTimesheetHours("7.5", "Mon")).toBe("7.50");
    expect(parseTimesheetHours("7.33", "Mon")).toBe("7.33");
    expect(parseTimesheetHours("24", "Mon")).toBe("24.00");
    expect(() => parseTimesheetHours("0", "Mon")).toThrow("Mon hours must not be zero.");
    expect(() => parseTimesheetHours("24.01", "Mon")).toThrow("Mon hours can't be more than 24.");
    expect(() => parseTimesheetHours("7.333", "Mon")).toThrow("Mon hours can have at most 2 decimal places.");
    expect(() => parseTimesheetHours("abc", "Mon")).toThrow("Mon hours must be a plain number like 12.34.");
    expect(() => parseTimesheetHours("-1", "Mon")).toThrow("Mon hours can't be negative.");
  });

  it("TS2, TS3: entered 4 days after is on time; 23 days after is flagged late (decision 38)", () => {
    expect(timesheetLateness("2026-07-06", "2026-07-10")).toEqual({ days: 4, late: false, text: "entered 4 days after the work" });
    expect(timesheetLateness("2026-07-13", "2026-08-05")).toEqual({ days: 23, late: true, text: "entered 23 days after the work" });
    expect(timesheetLateness("2026-07-13", "2026-07-27")).toMatchObject({ days: 14, late: false });
    expect(timesheetLateness("2026-07-13", "2026-07-28")).toMatchObject({ days: 15, late: true });
    expect(timesheetLateness("2026-07-13", "2026-07-13").text).toBe("entered on the day of the work");
    expect(timesheetLateness("2026-07-13", "2026-07-14").text).toBe("entered 1 day after the work");
  });

  it("TS5: fully covered, Ben's 2,000.00 splits 900.00 / 800.00 / 300.00 by 36 / 32 / 12 hours", () => {
    const weights = timesheetWeights({
      periodDays: 14,
      coveredDays: 14,
      rows: [
        { key: "C1", hours: "36.00" },
        { key: "Operations", hours: "32.00" },
        { key: "Taieri soil survey", hours: "12.00" },
      ],
      otherHours: "0",
      allocation: [
        { key: "alloc C1", percentage: "60" },
        { key: "alloc Operations", percentage: "40" },
      ],
    });
    // The allocation isn't used at all when every day is covered.
    expect(weights).toEqual([
      { key: "C1", source: "timesheet", weight: "50400" },
      { key: "Operations", source: "timesheet", weight: "44800" },
      { key: "Taieri soil survey", source: "timesheet", weight: "16800" },
    ]);
    const total = toFixedString(sum(weights.map((w) => dec(w.weight))), 0);
    expect(total).toBe("112000"); // 14 x 80 x 100
    expect(splitByWeights("2000.00", weights.map((w) => w.weight))).toEqual(["900.00", "800.00", "300.00"]);
    expect(weights.map((w) => percentageOfWeight(w.weight, total))).toEqual(["45.0000", "40.0000", "15.0000"]);
    expect(weightShareRoundedDown("2000.00", weights[0].weight, total, 2)).toBe("900.00");
  });

  it("TS6: half covered, the timesheet takes 7 days and the 60/40 allocation the other 7", () => {
    const weights = timesheetWeights({
      periodDays: 14,
      coveredDays: 7,
      rows: [
        { key: "C1", hours: "20.00" },
        { key: "Operations", hours: "20.00" },
      ],
      otherHours: "0.00",
      allocation: [
        { key: "alloc C1", percentage: "60.00" },
        { key: "alloc Operations", percentage: "40.00" },
      ],
    });
    expect(weights).toEqual([
      { key: "C1", source: "timesheet", weight: "14000" },
      { key: "Operations", source: "timesheet", weight: "14000" },
      { key: "alloc C1", source: "allocation", weight: "16800" },
      { key: "alloc Operations", source: "allocation", weight: "11200" },
    ]);
    expect(splitByWeights("2000.00", weights.map((w) => w.weight))).toEqual(["500.00", "500.00", "600.00", "400.00"]);
  });

  it("TS6: 'other work' hours are spread by the allocation; no covered hours means the allocation alone", () => {
    const withOther = timesheetWeights({
      periodDays: 14,
      coveredDays: 14,
      rows: [{ key: "C1", hours: "30" }],
      otherHours: "10",
      allocation: [{ key: "alloc Sales", percentage: "100" }],
    });
    expect(withOther).toEqual([
      { key: "C1", source: "timesheet", weight: "42000" },
      { key: "alloc Sales", source: "allocation", weight: "14000" },
    ]);
    expect(splitByWeights("1000.00", withOther.map((w) => w.weight))).toEqual(["750.00", "250.00"]);

    const none = timesheetWeights({ periodDays: 14, coveredDays: 7, rows: [], otherHours: "0", allocation: [{ key: "a", percentage: "60" }, { key: "b", percentage: "40" }] });
    expect(none).toEqual([
      { key: "a", source: "allocation", weight: "60" },
      { key: "b", source: "allocation", weight: "40" },
    ]);
  });

  it("TS7: 77 hours, the journal split shares cents by largest remainder (earlier on a tie), R&D rounds down", () => {
    const weights = timesheetWeights({
      periodDays: 14,
      coveredDays: 14,
      rows: [
        { key: "C1", hours: "48" },
        { key: "S1", hours: "4" },
        { key: "Operations", hours: "25" },
      ],
      otherHours: "0",
      allocation: [{ key: "alloc C1", percentage: "100" }],
    });
    const w = weights.map((entry) => entry.weight);
    expect(splitByWeights("2400.00", w)).toEqual(["1496.10", "124.68", "779.22"]);
    expect(splitByWeights("84.00", w)).toEqual(["52.37", "4.36", "27.27"]);
    const total = toFixedString(sum(w.map(dec)), 0);
    expect(weightShareRoundedDown("2484.00", w[0], total, 2)).toBe("1548.46");
    expect(weightShareRoundedDown("2484.00", w[1], total, 2)).toBe("129.03");
    // 80 hours (48 / 4 / 28): exact.
    const eighty = timesheetWeights({ periodDays: 14, coveredDays: 14, rows: [{ key: "C1", hours: "48" }, { key: "S1", hours: "4" }, { key: "Operations", hours: "28" }], otherHours: "0", allocation: [] });
    const e = eighty.map((entry) => entry.weight);
    expect(splitByWeights("2400.00", e)).toEqual(["1440.00", "120.00", "840.00"]);
    expect(splitByWeights("84.00", e)).toEqual(["50.40", "4.20", "29.40"]);
    const eightyTotal = toFixedString(sum(e.map(dec)), 0);
    expect(weightShareRoundedDown("2484.00", e[0], eightyTotal, 2)).toBe("1490.40");
    expect(weightShareRoundedDown("2484.00", e[1], eightyTotal, 2)).toBe("124.20");
  });

  it("TS8: Sione's 821.25 splits 675.00 Operations and 146.25 C1 by 30 and 6.5 hours", () => {
    const weights = timesheetWeights({ periodDays: 7, coveredDays: 7, rows: [{ key: "C1", hours: "6.50" }, { key: "Operations", hours: "30.00" }], otherHours: "0", allocation: [{ key: "alloc", percentage: "100" }] });
    expect(splitByWeights("821.25", weights.map((w) => w.weight))).toEqual(["146.25", "675.00"]);
    const total = toFixedString(sum(weights.map((w) => dec(w.weight))), 0);
    expect(percentageOfWeight(weights[0].weight, total)).toBe("17.8082");
  });

  it("PE3-PE4: splitting by weights gives exactly what splitting by percentages gives", () => {
    for (const [amount, percentages] of [
      ["1234.57", ["60", "40"]],
      ["10.00", ["33.33", "33.33", "33.34"]],
      ["0.01", ["50", "50"]],
      ["-1234.57", ["60", "40"]],
      ["98765.43", ["12.5", "0.01", "37.49", "25", "25"]],
    ] as const) {
      expect(splitByWeights(amount, [...percentages])).toEqual(splitByPercentages(amount, [...percentages]));
    }
    for (const amount of ["0.01", "0.07", "99.99", "-0.03"]) {
      const parts = splitByWeights(amount, ["3", "7", "11.5"]);
      expect(toFixedString(sum(parts.map(dec)), 2)).toBe(toFixedString(dec(amount), 2));
    }
  });

  it("coveredHoursOnly keeps the hours on days inside the pay period", () => {
    expect(
      coveredHoursOnly(
        [
          { workDate: "2026-06-29", hours: "8.00" },
          { workDate: "2026-07-01", hours: "7.50" },
          { workDate: "2026-07-05", hours: "2.00" },
        ],
        "2026-07-01",
        "2026-07-31",
      ),
    ).toEqual([
      { workDate: "2026-07-01", hours: "7.50" },
      { workDate: "2026-07-05", hours: "2.00" },
    ]);
  });
});
