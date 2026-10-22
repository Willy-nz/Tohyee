import { describe, expect, it } from "vitest";
import { columnNameForValue, datePartName, rowCountText, STEP_LABELS, STEP_ORDER, stepSummary } from "@/lib/analytics/shaping-labels";

describe("Prepare data step words", () => {
  it("offers every step once", () => {
    expect([...STEP_ORDER].sort()).toEqual(Object.keys(STEP_LABELS).sort());
  });

  it("says how a step changed the rows", () => {
    const counts = ["1204", "1168", "1168", "1"];
    expect(rowCountText(counts, 0)).toBe("1,168 rows (−36)");
    expect(rowCountText(counts, 1)).toBe("1,168 rows (no change)");
    expect(rowCountText(counts, 2)).toBe("1 row (−1,167)");
    expect(rowCountText(["2", "6"], 0)).toBe("6 rows (+4)");
    expect(rowCountText(counts, 3)).toBeNull();
    expect(rowCountText(undefined, 0)).toBeNull();
  });

  it("summarises the new steps", () => {
    expect(stepSummary({ type: "replace", columns: ["region"], find: null, replaceWith: "None", match: "whole" })).toBe('blank → "None" · region');
    expect(stepSummary({ type: "sort", by: [{ column: "sold", descending: true }, { column: "line", descending: false }] })).toBe("sold ↓, line ↑");
    expect(stepSummary({ type: "unpivot", other: true, columns: ["line"], attributeName: "a", valueName: "v" })).toBe("all but line");
    expect(stepSummary({ type: "distinct", columns: ["a", "b", "c", "d", "e"] })).toBe("by a, b, c and 2 more");
    expect(stepSummary({ type: "pivot", column: "month", valueColumn: "amount", operation: "sum", columns: [{ value: "jan", name: "jan" }] })).toBe("month into 1 column");
  });

  it("makes column names from values that aren't taken", () => {
    expect(columnNameForValue("Jan 2026", new Set())).toBe("jan_2026");
    expect(columnNameForValue("Ōtākou", new Set())).toBe("otakou");
    expect(columnNameForValue("2026", new Set())).toBe("value_2026");
    expect(columnNameForValue("", new Set())).toBe("value");
    expect(columnNameForValue("North", new Set(["north"]))).toBe("north_2");
    expect(datePartName("sold", "financial_year", new Set(["sold_financial_year"]))).toBe("sold_financial_year_2");
  });
});
