import { describe, expect, it } from "vitest";
import { keyFigure } from "@/lib/analytics/key-figure";
import { addMonths, previousPeriod, previousYear } from "@/lib/analytics/periods";
import type { QueryResult } from "@/lib/analytics/query";

const money = (key: string, label: string) => ({ key, label, format: "money" as const, role: "measure" as const });

describe("key figure comparisons (#334)", () => {
  it("works out the change as an amount and a percentage, exactly", () => {
    const result: QueryResult = { columns: [money("m0", "Sales"), money("m0_pp", "Sales previous period")], rows: [{ m0: "1500.00", m0_pp: "1200.00" }], truncated: false };
    expect(keyFigure(result)).toMatchObject({
      value: "1500.00",
      comparison: { label: "previous period", value: "1200.00" },
      change: "300.00",
      percent: "25.0",
      direction: "up",
      good: true,
      others: [],
    });
  });

  it("says a fall is good news when down is good, e.g. expenses", () => {
    const result: QueryResult = { columns: [money("m0", "Expenses"), money("m0_py", "Expenses last year")], rows: [{ m0: "0.10", m0_py: "0.30" }], truncated: false };
    expect(keyFigure(result, { kpi: { downIsGood: true } })).toMatchObject({
      comparison: { label: "same period last year" },
      change: "-0.20",
      percent: "-66.7",
      direction: "down",
      good: true,
    });
    expect(keyFigure(result)).toMatchObject({ good: false });
  });

  it("compares with a target, and has no percentage when the comparison is zero or missing", () => {
    const result: QueryResult = { columns: [money("m0", "Sales")], rows: [{ m0: "4500.00" }], truncated: false };
    expect(keyFigure(result, { kpi: { target: "5000" } })).toMatchObject({ comparison: { label: "target", value: "5000" }, change: "-500.00", percent: "-10.0", direction: "down", good: false });
    expect(keyFigure(result, { kpi: { target: "0" } })).toMatchObject({ change: "4500.00", percent: null });
    const missing: QueryResult = { columns: [money("m0", "Sales"), money("m0_pp", "x")], rows: [{ m0: "1", m0_pp: null }], truncated: false };
    expect(keyFigure(missing)).toMatchObject({ change: null, percent: null, direction: null });
    expect(keyFigure(result)).toMatchObject({ comparison: null, change: null });
  });

  it("keeps further values to show underneath", () => {
    const result: QueryResult = { columns: [money("m0", "Sales"), money("m1", "Costs")], rows: [{ m0: "1", m1: "2" }], truncated: false };
    expect(keyFigure(result)?.others).toEqual([{ column: money("m1", "Costs"), value: "2" }]);
  });
});

describe("the period to compare with (#334)", () => {
  it("moves whole months back by months, other ranges by days", () => {
    expect(previousPeriod("2026-10-01", "2026-10-31")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousPeriod("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod("2026-04-01", "2027-03-31")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(previousPeriod("2026-07-01", "2026-09-30")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(previousPeriod("2026-10-08", "2026-10-14")).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(previousPeriod("2026-10-01", null)).toBeNull();
    expect(previousPeriod("2026-10-31", "2026-10-01")).toBeNull();
  });

  it("moves back a year, keeping month ends", () => {
    expect(previousYear("2026-04-01", "2027-03-31")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(previousYear("2028-02-01", "2028-02-29")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(previousYear("2025-02-01", "2025-02-28")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(previousYear("2026-10-05", "2026-10-20")).toEqual({ from: "2025-10-05", to: "2025-10-20" });
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
});
