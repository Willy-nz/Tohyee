import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { columnHeaderRows, columnPathText, initiallyCollapsed, isGroupRow, steppedRows, visibleWithCollapsed } from "@/lib/analytics/matrix";
import type { PivotData, PivotRow, ResultColumn } from "@/lib/analytics/query";

const row = (kind: PivotRow["kind"], depth: number, dimensions: Array<string | null>): PivotRow => ({ key: JSON.stringify([depth, dimensions.slice(0, depth)]), kind, depth, dimensions, cells: {} });

// Region › product › channel, as the server sends them: each group's rows, then its subtotal; the grand total last.
const rows: PivotRow[] = [
  row("detail", 3, ["North", "Gadgets", "Web"]),
  row("detail", 3, ["North", "Gadgets", "Shop"]),
  row("subtotal", 2, ["North", "Gadgets", null]),
  row("detail", 3, ["North", "Widgets", "Web"]),
  row("subtotal", 2, ["North", "Widgets", null]),
  row("subtotal", 1, ["North", null, null]),
  row("detail", 3, ["South", "Widgets", "Web"]),
  row("subtotal", 2, ["South", "Widgets", null]),
  row("subtotal", 1, ["South", null, null]),
  row("grand_total", 0, [null, null, null]),
];
const names = (list: PivotRow[]) => list.map((entry) => `${entry.kind[0]}${entry.depth}:${entry.dimensions.filter(Boolean).join("/")}`);

describe("matrix rows", () => {
  it("moves each group's total above its rows for the stepped layout", () => {
    expect(names(steppedRows(rows, 3))).toEqual([
      "s1:North",
      "s2:North/Gadgets",
      "d3:North/Gadgets/Web",
      "d3:North/Gadgets/Shop",
      "s2:North/Widgets",
      "d3:North/Widgets/Web",
      "s1:South",
      "s2:South/Widgets",
      "d3:South/Widgets/Web",
      "g0:",
    ]);
    // One row field: nothing to move.
    const flat = [row("detail", 1, ["A"]), row("detail", 1, ["B"]), row("grand_total", 0, [null])];
    expect(steppedRows(flat, 1)).toEqual(flat);
  });

  it("hides everything inside a closed group, keeping the group's own row", () => {
    const north = rows.find((entry) => entry.kind === "subtotal" && entry.depth === 1 && entry.dimensions[0] === "North")!;
    const southWidgets = rows.find((entry) => entry.depth === 2 && entry.dimensions[0] === "South")!;
    expect(names(visibleWithCollapsed(steppedRows(rows, 3), new Set([north.key, southWidgets.key])))).toEqual(["s1:North", "s1:South", "s2:South/Widgets", "g0:"]);
    expect(visibleWithCollapsed(rows, new Set())).toBe(rows);
  });

  it("opens groups down to a chosen level to start with", () => {
    expect(initiallyCollapsed(rows, 3, undefined).size).toBe(0);
    expect(names(visibleWithCollapsed(steppedRows(rows, 3), initiallyCollapsed(rows, 3, 1)))).toEqual(["s1:North", "s1:South", "g0:"]);
    expect(names(visibleWithCollapsed(steppedRows(rows, 3), initiallyCollapsed(rows, 3, 2)))).toEqual(["s1:North", "s2:North/Gadgets", "s2:North/Widgets", "s1:South", "s2:South/Widgets", "g0:"]);
    expect(isGroupRow(rows[0], 3)).toBe(false);
    expect(isGroupRow(rows[2], 3)).toBe(true);
  });
});

describe("matrix column headers", () => {
  const measure: ResultColumn = { key: "m0", label: "Sales", format: "money", role: "measure" };
  const field = (label: string, key: string): ResultColumn => ({ key, label, format: "text", role: "category" });
  const pivot: PivotData = {
    rowFields: [field("region", "r")],
    columnField: field("year", "pivot_column"),
    columnFields: [field("year", "pivot_column"), field("channel", "pivot_column_1")],
    columnValues: ["2025", "2026"],
    rows: [],
    columns: [
      { key: "c0_m0", label: "Shop", pivotValue: "2025", path: ["2025", "Shop"], measure, total: false },
      { key: "c1_m0", label: "Web", pivotValue: "2025", path: ["2025", "Web"], measure, total: false },
      { key: "c2_m0", label: "2025", pivotValue: "2025", path: ["2025"], subtotal: true, measure, total: false },
      { key: "c3_m0", label: "Web", pivotValue: "2026", path: ["2026", "Web"], measure, total: false },
      { key: "c4_m0", label: "2026", pivotValue: "2026", path: ["2026"], subtotal: true, measure, total: false },
      { key: "total_m0", label: "Grand total", pivotValue: null, measure, total: true },
    ],
  };
  const label = (_level: number, value: string | null) => value ?? "(blank)";

  it("spans each outer value over its columns, with its total spanning down and the grand total spanning all", () => {
    const header = columnHeaderRows(pivot, label);
    expect(header.map((cells) => cells.map((cell) => [cell.text, cell.colSpan, cell.rowSpan]))).toEqual([
      [["2025", 3, 1], ["2026", 2, 1], ["Grand total", 1, 2]],
      [["Shop", 1, 1], ["Web", 1, 1], ["Total", 1, 1], ["Web", 1, 1], ["Total", 1, 1]],
    ]);
  });

  it("names a column by its path for exports", () => {
    expect(columnPathText(pivot.columns[1], label)).toBe("2025 › Web");
    expect(columnPathText(pivot.columns[2], label)).toBe("2025 total");
    expect(columnPathText(pivot.columns[5], label)).toBe("Grand total");
  });

  it("keeps a single column field's headers as before", () => {
    const single: PivotData = {
      ...pivot,
      columnFields: undefined,
      columns: [
        { key: "c0_m0", label: "2025", pivotValue: "2025", measure, total: false },
        { key: "c0_m1", label: "2025", pivotValue: "2025", measure: { ...measure, key: "m1" }, total: false },
        { key: "total_m0", label: "Grand total", pivotValue: null, measure, total: true },
        { key: "total_m1", label: "Grand total", pivotValue: null, measure: { ...measure, key: "m1" }, total: true },
      ],
    };
    expect(columnHeaderRows(single, label).map((cells) => cells.map((cell) => [cell.text, cell.colSpan, cell.rowSpan]))).toEqual([[["2025", 2, 1], ["Grand total", 2, 1]]]);
  });

  it("saves the layout and levels open", () => {
    expect(parseChartFormat({ table: { layout: "stepped", expandTo: 2 } })).toEqual({ table: { layout: "stepped", expandTo: 2 } });
    expect(() => parseChartFormat({ table: { layout: "sideways" } })).toThrow();
    expect(() => parseChartFormat({ table: { expandTo: 9 } })).toThrow(/1 to 4/);
  });
});
