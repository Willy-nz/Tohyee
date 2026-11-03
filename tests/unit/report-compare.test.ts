import { describe, expect, it } from "vitest";
import {
  chosenFirst,
  compareAmountColumns,
  monthsBefore,
  periodOrderStorageKey,
  rememberedPeriodOrder,
  searchWithOrder,
  withPercentColumns,
} from "@/lib/reports/compare-columns";
import { parseCompare, percentOf } from "@/lib/reports/statement-compare";

const cols = (columns: ReturnType<typeof compareAmountColumns>) => columns.map((column) => [column.key, column.label, column.from, column.to]);

describe("comparing periods (decision 1353)", () => {
  it("compares a whole month with earlier months, as custom reports label them (RX1)", () => {
    expect(
      cols(compareAmountColumns("profit_and_loss", { from: "2026-06-01", to: "2026-06-30" }, { periods: 2, periodLength: "month", total: true, order: "newest_first" }, 3)),
    ).toEqual([
      ["p0", "Jun 2026", "2026-06-01", "2026-06-30"],
      ["p1", "May 2026", "2026-05-01", "2026-05-31"],
      ["p2", "Apr 2026", "2026-04-01", "2026-04-30"],
      ["total", "Total", null, null],
    ]);
  });

  it("compares quarters and years, oldest first by default (RX1, RX7)", () => {
    const quarters = compareAmountColumns("profit_and_loss", { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "quarter" }, 3);
    expect(cols(quarters)).toEqual([
      ["p1", "Jan - Mar 2026", "2026-01-01", "2026-03-31"],
      ["p0", "Apr - Jun 2026", "2026-04-01", "2026-06-30"],
    ]);
    const years = compareAmountColumns("profit_and_loss", { from: "2026-04-01", to: "2026-06-30" }, { periods: 1, periodLength: "year" }, 3);
    expect(cols(years)[0]).toEqual(["p1", "1 Apr-30 Jun 2025", "2025-04-01", "2025-06-30"]);
  });

  it("runs the periods oldest first, with Total and Year to date still last (RX7)", () => {
    const setting = { periods: 11, periodLength: "month" as const, total: true, yearToDate: true };
    const columns = compareAmountColumns("profit_and_loss", { from: "2026-11-01", to: "2026-11-30" }, setting, 3);
    expect(columns.map((column) => column.label)).toEqual([
      "Dec 2025",
      "Jan 2026",
      "Feb 2026",
      "Mar 2026",
      "Apr 2026",
      "May 2026",
      "Jun 2026",
      "Jul 2026",
      "Aug 2026",
      "Sep 2026",
      "Oct 2026",
      "Nov 2026",
      "Total",
      "Year to date",
    ]);
    // The keys and dates don't change with the order, so drill-down links are the same.
    const newest = compareAmountColumns("profit_and_loss", { from: "2026-11-01", to: "2026-11-30" }, { ...setting, order: "newest_first" }, 3);
    expect(newest.map((column) => column.label).slice(0, 2)).toEqual(["Nov 2026", "Oct 2026"]);
    expect(newest.slice(-2).map((column) => column.key)).toEqual(["total", "ytd"]);
    const byKey = (list: typeof columns) => Object.fromEntries(list.map((column) => [column.key, [column.from, column.to, column.drillFrom]]));
    expect(byKey(columns)).toEqual(byKey(newest));
    // % columns follow their amount column.
    expect(withPercentColumns(columns, true).map((column) => column.key).slice(0, 4)).toEqual(["p11", "p11_pct", "p10", "p10_pct"]);
    // Reports are run and merged chosen dates first, whichever way they're shown.
    expect(chosenFirst(columns).map((column) => column.key)).toEqual(newest.map((column) => column.key));
  });

  it("runs a balance sheet's dates oldest first too (RX7)", () => {
    const columns = compareAmountColumns("balance_sheet", { from: null, to: "2026-11-30" }, { periods: 2, periodLength: "quarter" }, 3);
    expect(columns.map((column) => [column.key, column.label])).toEqual([
      ["p2", "31 May 2026"],
      ["p1", "31 Aug 2026"],
      ["p0", "30 Nov 2026"],
    ]);
  });

  it("reads the order, refusing anything else (decision 1366)", () => {
    expect(parseCompare({ compare: "2" })?.order).toBe("oldest_first");
    expect(parseCompare({ compare: "2", order: "newest_first" })?.order).toBe("newest_first");
    expect(() => parseCompare({ compare: "2", order: "sideways" })).toThrow(/oldest_first/);
    expect(parseCompare({ order: "newest_first" })).toBeNull();
  });

  it("remembers each report's last choice, the address first (decision 1367)", () => {
    const store = new Map<string, string>([[periodOrderStorageKey("profit_and_loss"), "newest_first"]]);
    const storage = { getItem: (key: string) => store.get(key) ?? null };
    expect(rememberedPeriodOrder("profit_and_loss", "", storage)).toBe("newest_first");
    expect(rememberedPeriodOrder("balance_sheet", "", storage)).toBe("oldest_first");
    expect(rememberedPeriodOrder("profit_and_loss", "?report=pnl&order=oldest_first", storage)).toBe("oldest_first");
    expect(rememberedPeriodOrder("profit_and_loss", "?order=junk", null)).toBe("oldest_first");
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(rememberedPeriodOrder("profit_and_loss", "", throwing)).toBe("oldest_first");
    expect(searchWithOrder("?report=pnl", "newest_first")).toBe("?report=pnl&order=newest_first");
    expect(searchWithOrder("?report=pnl&order=newest_first", null)).toBe("?report=pnl");
    expect(searchWithOrder("?order=oldest_first", null)).toBe("");
  });

  it("moves other dates back with the same days, and adds the year to date (RX2)", () => {
    const columns = compareAmountColumns("profit_and_loss", { from: "2026-06-01", to: "2026-06-20" }, { periods: 1, periodLength: "month", yearToDate: true, order: "newest_first" }, 3);
    expect(cols(columns)).toEqual([
      ["p0", "1-20 Jun 2026", "2026-06-01", "2026-06-20"],
      ["p1", "1-20 May 2026", "2026-05-01", "2026-05-20"],
      ["ytd", "Year to date", "2026-04-01", "2026-06-20"],
    ]);
    expect(monthsBefore("2026-05-31", 1)).toBe("2026-04-30");
    expect(monthsBefore("2026-03-30", 1)).toBe("2026-02-28");
  });

  it("compares a balance sheet's dates, each opening from its own financial year (RX3)", () => {
    const columns = compareAmountColumns("balance_sheet", { from: null, to: "2026-06-30" }, { periods: 1, periodLength: "month", order: "newest_first" }, 3);
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
