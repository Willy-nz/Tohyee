import { describe, expect, it } from "vitest";
import { groupAccounts, moveRow, standardLayout } from "@/lib/reports/custom-layout";

describe("editing a layout (decisions 1359-1360)", () => {
  it("starts from the standard report's labels", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const rows = layout.blocks[0].kind === "table" ? layout.blocks[0].rows : [];
    expect(rows.map((row) => row.label)).toEqual(["Trading income", "Cost of sales", "Gross profit", "Other income", "Operating expenses", "Net profit"]);
    const sheet = standardLayout("balance_sheet", "2026-06-30");
    expect(sheet.blocks[0].kind === "table" ? sheet.blocks[0].rows.map((row) => row.label) : []).toContain("Net assets");
  });

  it("groups accounts without changing any total (CR16)", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const { layout: grouped, rowId } = groupAccounts(layout, "main", "expenses", ["6120"], "Vehicle costs", "vehicle");
    const rows = grouped.blocks[0].kind === "table" ? grouped.blocks[0].rows : [];
    expect(rowId).toBe("vehicle");
    expect(rows.map((row) => row.id)).toEqual(["revenue", "cost_of_sales", "gross_profit", "other_income", "expenses", "vehicle", "net_profit"]);
    expect(rows.find((row) => row.id === "expenses")).toMatchObject({ accountTypes: ["expense", "depreciation"], exceptCodes: ["6120"] });
    expect(rows.find((row) => row.id === "vehicle")).toMatchObject({ kind: "group", accountCodes: ["6120"] });
    expect(rows.find((row) => row.id === "net_profit")).toMatchObject({
      terms: [
        { rowId: "gross_profit", sign: 1 },
        { rowId: "other_income", sign: 1 },
        { rowId: "expenses", sign: -1 },
        { rowId: "vehicle", sign: -1 },
      ],
    });
    // The original isn't changed.
    expect(layout.blocks[0].kind === "table" ? layout.blocks[0].rows.length : 0).toBe(6);
  });

  it("moves a row to another place", () => {
    const layout = standardLayout("profit_and_loss", "2026-06-30");
    const moved = moveRow(layout, "main", "expenses", 1);
    expect(moved.blocks[0].kind === "table" ? moved.blocks[0].rows.map((row) => row.id) : []).toEqual([
      "revenue",
      "expenses",
      "cost_of_sales",
      "gross_profit",
      "other_income",
      "net_profit",
    ]);
  });
});
