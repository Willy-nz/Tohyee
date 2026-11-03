import { describe, expect, it } from "vitest";
import { compareAmountColumns, monthsBefore, withPercentColumns } from "@/lib/reports/compare-columns";
import { percentOf } from "@/lib/reports/statement-compare";

const cols = (columns: ReturnType<typeof compareAmountColumns>) => columns.map((column) => [column.key, column.label, column.from, column.to]);

describe("comparing periods (decision 1353)", () => {
  it("compares a whole month with earlier months, as custom reports label them (RX1)", () => {
    expect(cols(compareAmountColumns("profit_and_loss", { from: "2026-06-01", to: "2026-06-30" }, { periods: 2, periodLength: "month", total: true }, 3))).toEqual([
      ["p0", "Jun 2026", "2026-06-01", "2026-06-30"],
      ["p1", "May 2026", "2026-05-01", "2026-05-31"],
      ["p2", "Apr 2026", "2026-04-01", "2026-04-30"],
      ["total", "Total", null, null],
    ]);
  });

  it("compares quarters and years (RX1)", () => {
    const quarters = compareAmountColumns("profit_and_loss", { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "quarter" }, 3);
    expect(cols(quarters)).toEqual([
      ["p0", "Apr - Jun 2026", "2026-04-01", "2026-06-30"],
      ["p1", "Jan - Mar 2026", "2026-01-01", "2026-03-31"],
    ]);
    const years = compareAmountColumns("profit_and_loss", { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "year" }, 3);
    expect(cols(years)[1]).toEqual(["p1", "1 Apr-30 Jun 2025", "2025-04-01", "2025-06-30"]);
  });

  it("moves other dates back with the same days, and adds the year to date (RX2)", () => {
    const columns = compareAmountColumns("profit_and_loss", { from: "2026-06-01", to: "2026-06-20" }, { periods: 1, periodLength: "month", yearToDate: true }, 3);
    expect(cols(columns)).toEqual([
      ["p0", "1-20 Jun 2026", "2026-06-01", "2026-06-20"],
      ["p1", "1-20 May 2026", "2026-05-01", "2026-05-20"],
      ["ytd", "Year to date", "2026-04-01", "2026-06-20"],
    ]);
    expect(monthsBefore("2026-05-31", 1)).toBe("2026-04-30");
    expect(monthsBefore("2026-03-30", 1)).toBe("2026-02-28");
  });

  it("compares a balance sheet's dates, each opening from its own financial year (RX3)", () => {
    const columns = compareAmountColumns("balance_sheet", { from: null, to: "2026-06-30" }, { periods: 1, periodLength: "month" }, 3);
    expect(columns.map((column) => [column.label, column.to, column.drillFrom])).toEqual([
      ["30 Jun 2026", "2026-06-30", "2026-04-01"],
      ["31 May 2026", "2026-05-31", "2026-04-01"],
    ]);
  });

  it("puts a % column beside each amount column (RX4)", () => {
    const columns = withPercentColumns(compareAmountColumns("profit_and_loss", { from: "2026-06-01", to: "2026-06-30" }, { periods: 0, periodLength: "month" }, 3), true);
    expect(columns.map((column) => [column.key, column.kind, column.of ?? null])).toEqual([
      ["p0", "period", null],
      ["p0_pct", "percent", "p0"],
    ]);
  });
});

describe("% of trading income (decision 1354, RX4)", () => {
  it("rounds to 1 decimal place, halves away from zero, and is blank with no income", () => {
    expect(percentOf("1200.00", "1200.00")).toBe("100.0");
    expect(percentOf("20.00", "1200.00")).toBe("1.7");
    expect(percentOf("250.00", "1200.00")).toBe("20.8");
    expect(percentOf("670.00", "1200.00")).toBe("55.8");
    expect(percentOf("-60.00", "1200.00")).toBe("-5.0");
    expect(percentOf("0.25", "2.00")).toBe("12.5");
    expect(percentOf("-0.25", "2.00")).toBe("-12.5");
    expect(percentOf("100.00", "0.00")).toBeNull();
  });
});
