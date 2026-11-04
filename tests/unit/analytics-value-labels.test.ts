import { describe, expect, it } from "vitest";
import { showValue } from "@/lib/analytics/display";
import { buildPivotSql, buildTileSql, type ColumnInfo, type TileQuery } from "@/lib/analytics/query";
import { valueLabel, valueLabelsFor } from "@/lib/analytics/value-labels";

/** The books' coded values in words (decision 1499): shown as the chart of accounts names them, kept and filtered as codes. */
describe("value labels for the books' coded fields", () => {
  const ledger: ColumnInfo[] = [
    { name: "posting_date", type: "DATE" },
    { name: "account_type", type: "VARCHAR" },
    { name: "account_class", type: "VARCHAR" },
    { name: "account_name", type: "VARCHAR" },
    { name: "amount", type: "DECIMAL(18,2)" },
  ];
  const query = (overrides: Partial<TileQuery> = {}): TileQuery => ({
    table: "tohyee_ledger_lines",
    groupBy: { field: "account_type" },
    measures: [{ label: "Amount", aggregate: "sum", field: "amount" }],
    filters: [{ field: "account_type", op: "in", value: ["current_liability", "fixed_asset"] }],
    dateField: null,
    sort: { by: "category", direction: "asc" },
    limit: null,
    ...overrides,
  });

  it("names account types and classes as the chart of accounts does", () => {
    expect(["bank", "current_liability", "fixed_asset", "other_income", "revenue", "non_current_liability", "direct_costs"].map((code) => valueLabel("tohyee_ledger_lines", "account_type", code))).toEqual([
      "Bank",
      "Current liability",
      "Fixed asset",
      "Other income",
      "Revenue",
      "Non-current liability",
      "Direct costs",
    ]);
    expect(valueLabel("tohyee_ledger_lines", "account_class", "revenue")).toBe("Income");
    expect(valueLabel("tohyee_invoices", "status", "voided")).toBe("Voided");
    // Not coded, or a code it doesn't know: as it is.
    expect(valueLabel("tohyee_ledger_lines", "account_name", "bank")).toBe("bank");
    expect(valueLabel("sales", "account_type", "bank")).toBe("bank");
    expect(valueLabel("tohyee_ledger_lines", "account_type", "made_up")).toBe("made_up");
  });

  it("a grouped tile's column carries the labels; the SQL still groups and filters by the code", () => {
    const built = buildTileSql(query({ breakdown: { field: "account_class" } }), ledger);
    const [category, breakdown] = built.columns;
    expect(category.valueLabels?.current_liability).toBe("Current liability");
    expect(breakdown.valueLabels?.asset).toBe("Assets");
    expect(built.columns.find((column) => column.role === "measure")?.valueLabels).toBeUndefined();
    expect(built.params).toEqual(expect.arrayContaining(["current_liability", "fixed_asset"]));
    expect(built.sql).not.toContain("Current liability");
    // A date group is never labelled.
    expect(buildTileSql(query({ groupBy: { field: "posting_date", grain: "month" } }), ledger).columns[0].valueLabels).toBeUndefined();
    // Pivot rows and columns too.
    const pivot = buildPivotSql(query({ groupBy: null, pivot: { rows: [{ field: "account_type" }], column: { field: "account_class" } } }), ledger);
    expect(pivot.rowFields[0].valueLabels?.fixed_asset).toBe("Fixed asset");
    expect(pivot.columnFields[0].valueLabels?.liability).toBe("Liabilities");
  });

  it("showValue shows the label, and anything else as before", () => {
    const column = { format: "text" as const, valueLabels: valueLabelsFor("tohyee_ledger_lines", "account_type") };
    expect(showValue("current_liability", column)).toBe("Current liability");
    expect(showValue("something_else", column)).toBe("something_else");
    expect(showValue(null, column)).toBe("");
    expect(showValue("current_liability", { format: "text" })).toBe("current_liability");
  });
});
