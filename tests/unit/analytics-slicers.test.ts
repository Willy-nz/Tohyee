import { describe, expect, it } from "vitest";
import { parseFilter } from "@/lib/analytics/query";
import { effectiveDates, parsePageFilters, parseTileDates, tileDatesText } from "@/lib/analytics/report-filters";
import { parseRanges, parseSlicerExtras, rangeFilters, rangeText, slicerOnPage, slicerValueFields, stylesFor, type SlicerSetting } from "@/lib/analytics/slicers";

const columns = new Map([
  ["region", "VARCHAR"],
  ["town", "VARCHAR"],
  ["amount", "DECIMAL(18,2)"],
  ["sold_on", "DATE"],
  ["paid", "BOOLEAN"],
]);
const pages = new Set(["a", "b"]);

describe("slicer styles (#376 phase 3, decision 757)", () => {
  it("offers styles that suit the column", () => {
    expect(stylesFor("VARCHAR")).toContain("hierarchy");
    expect(stylesFor("DECIMAL(18,2)")[0]).toBe("range");
    expect(stylesFor("DATE")).toEqual(["dates", "relative"]);
  });

  it("checks a slicer's style, second level, pages and look", () => {
    expect(parseSlicerExtras({ field: "region" }, "VARCHAR", columns, pages, "Region")).toEqual({});
    expect(parseSlicerExtras({ field: "region", style: "hierarchy", child: "town", pages: ["b"], look: { size: "large", junk: 1 } }, "VARCHAR", columns, pages, "Region")).toEqual({
      style: "hierarchy",
      child: "town",
      pages: ["b"],
      look: { size: "large" },
    });
    // Every page is the same as no pages: synced.
    expect(parseSlicerExtras({ field: "region", pages: ["a", "b"] }, "VARCHAR", columns, pages, "Region")).toEqual({});
    expect(() => parseSlicerExtras({ field: "region", style: "range" }, "VARCHAR", columns, pages, "Region")).toThrow("doesn't suit");
    expect(() => parseSlicerExtras({ field: "sold_on" }, "DATE", columns, pages, "Sold")).toThrow("date range");
    expect(() => parseSlicerExtras({ field: "region", style: "hierarchy", child: "amount" }, "VARCHAR", columns, pages, "Region")).toThrow("text column");
    expect(() => parseSlicerExtras({ field: "region", style: "hierarchy", child: "nope" }, "VARCHAR", columns, pages, "Region")).toThrow("second level");
    expect(() => parseSlicerExtras({ field: "region", pages: ["z"] }, "VARCHAR", columns, pages, "Region")).toThrow("isn't in this report");
    expect(slicerOnPage({ pages: ["b"] }, "a")).toBe(false);
    expect(slicerOnPage({}, "a")).toBe(true);
  });

  const slicers: SlicerSetting[] = [
    { table: "sales", field: "region", label: "Region", style: "hierarchy", child: "town" },
    { table: "sales", field: "amount", label: "Amount", style: "range" },
    { table: "sales", field: "sold_on", label: "Sold", style: "relative" },
    { table: "sales", field: "paid", label: "Paid" },
  ];

  it("turns range choices into filters, only for the report's own range slicers", () => {
    const ranges = parseRanges({ amount: { min: "10", max: "99.5" }, sold_on: { last: { count: 3, unit: "months" } }, region: { min: "A" }, secret: { min: "1" } });
    expect(rangeFilters(slicers, ranges)).toEqual([
      { field: "amount", op: "gte", value: "10" },
      { field: "amount", op: "lte", value: "99.5" },
      { field: "sold_on", op: "last_months", value: "3" },
    ]);
    expect(() => rangeFilters(slicers, { amount: { min: "ten" } })).toThrow("enter a number");
    expect(() => parseRanges({ sold_on: { last: { count: 0, unit: "days" } } })).toThrow("how many");
    expect(slicerValueFields(slicers)).toEqual(new Set(["region", "town", "paid"]));
    expect(rangeText("range", { min: "10", max: "20" })).toBe("10 to 20");
    expect(rangeText("relative", { last: { count: 1, unit: "months" } })).toBe("Last 1 month");
    expect(rangeText("dates", undefined)).toBe("All");
  });
});

describe("a tile's own dates and a page's filters (#376 phase 3, decision 758)", () => {
  it("uses a tile's own dates in place of the report's", () => {
    expect(parseTileDates({ preset: "last_financial_year" }, "Sales")).toEqual({ preset: "last_financial_year" });
    expect(parseTileDates({ from: "2026-01-01", to: "" }, "Sales")).toEqual({ from: "2026-01-01", to: null });
    expect(() => parseTileDates({ preset: "next_year" }, "Sales")).toThrow("from the list");
    expect(() => parseTileDates({ from: "2026-02-01", to: "2026-01-01" }, "Sales")).toThrow("after");
    // A 31 May balance date.
    expect(effectiveDates({ preset: "last_financial_year" }, { from: "2026-10-01", to: "2026-10-31" }, "2026-10-22", 5)).toEqual({ from: "2025-06-01", to: "2026-05-31" });
    expect(effectiveDates(undefined, { from: "2026-10-01", to: null }, "2026-10-22", 5)).toEqual({ from: "2026-10-01", to: null });
    expect(tileDatesText({ preset: "this_month" })).toBe("Dates: this month");
    expect(tileDatesText({ from: null, to: null })).toBe("Dates: all time");
  });

  it("checks a page's filters against the tables", () => {
    const tables = new Map([["sales", [...columns].map(([name, type]) => ({ name, type }))]]);
    expect(parsePageFilters([{ table: "sales", filter: { field: "region", op: "eq", value: "Otago" } }], tables, parseFilter, "Detail")).toEqual([
      { table: "sales", filter: { field: "region", op: "eq", value: "Otago" } },
    ]);
    expect(() => parsePageFilters([{ table: "nope", filter: {} }], tables, parseFilter, "Detail")).toThrow("data source");
    expect(() => parsePageFilters([{ table: "sales", filter: { field: "secret", op: "eq", value: "x" } }], tables, parseFilter, "Detail")).toThrow("no column");
  });
});
