import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { columnValues, runTile } from "@/lib/analytics/dashboards";
import { financialQuarter, matchingPreset, presetRange } from "@/lib/analytics/date-ranges";
import { showValue } from "@/lib/analytics/display";
import { closeAnalytics, replaceTableFromSelect } from "@/lib/analytics/engine";
import { fieldLabel, tableDescription, tableLabel } from "@/lib/analytics/labels";
import { formatOfType } from "@/lib/analytics/query";

describe("date presets (decision 577)", () => {
  // 20 October 2026, with New Zealand's usual 31 March balance date.
  const today = "2026-10-20";

  it("works out each preset from today", () => {
    expect(presetRange("this_month", today, 3)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("last_month", today, 3)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("this_quarter", today, 3)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(presetRange("this_financial_year", today, 3)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(presetRange("last_financial_year", today, 3)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect(presetRange("last_12_months", today, 3)).toEqual({ from: "2025-11-01", to: "2026-10-20" });
    expect(presetRange("all_time", today, 3)).toEqual({ from: null, to: null });
  });

  it("follows the organisation's balance date", () => {
    // A 31 May balance date (a dairy farm's): the year runs June to May, quarters from June.
    expect(presetRange("this_financial_year", today, 5)).toEqual({ from: "2026-06-01", to: "2027-05-31" });
    expect(presetRange("last_financial_year", today, 5)).toEqual({ from: "2025-06-01", to: "2026-05-31" });
    expect(financialQuarter(today, 5)).toEqual({ from: "2026-09-01", to: "2026-11-30" });
    // A 31 December balance date: calendar years.
    expect(presetRange("this_financial_year", today, 12)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("handles the turn of the year and February", () => {
    expect(presetRange("last_month", "2026-01-05", 3)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("this_month", "2028-02-10", 3)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(presetRange("this_quarter", "2027-03-31", 3)).toEqual({ from: "2027-01-01", to: "2027-03-31" });
    expect(presetRange("this_financial_year", "2027-03-31", 3)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(presetRange("this_financial_year", "2027-04-01", 3)).toEqual({ from: "2027-04-01", to: "2028-03-31" });
  });

  it("recognises dates that are a preset", () => {
    expect(matchingPreset({ from: "2026-04-01", to: "2027-03-31" }, today, 3)).toBe("this_financial_year");
    expect(matchingPreset({ from: "", to: "" }, today, 3)).toBe("all_time");
    expect(matchingPreset({ from: "2026-04-02", to: "2027-03-31" }, today, 3)).toBeNull();
  });
});

describe("friendly names (decision 577)", () => {
  it("names Tohyee's tables and columns in plain words", () => {
    expect(tableLabel("tohyee_invoices")).toBe("Invoices");
    expect(tableLabel("tohyee_invoice_lines")).toBe("Invoice lines");
    expect(tableLabel("tohyee_ledger_lines")).toBe("Ledger");
    expect(tableLabel("tohyee_crm_opportunities")).toBe("CRM opportunities");
    expect(tableDescription("tohyee_ledger_lines")).toMatch(/general ledger/);
    expect(tableDescription("sales_2025")).toBe("");
    expect(fieldLabel("account_class")).toBe("Account class");
    expect(fieldLabel("is_customer")).toBe("Is customer");
    expect(fieldLabel("tracking_department")).toBe("Tracking department");
  });

  it("shows true and false as Yes and No", () => {
    expect(formatOfType("BOOLEAN")).toBe("boolean");
    expect(showValue("true", { format: "boolean" })).toBe("Yes");
    expect(showValue("false", { format: "boolean" })).toBe("No");
    expect(showValue("true", { format: "text" })).toBe("true");
  });
});

describe("Yes/No columns in tiles and slicers", () => {
  const ORG = "friendly-test";
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-friendly-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    await replaceTableFromSelect(
      ORG,
      "people",
      "select * from (values ('Aroha', true, 10.00::DECIMAL(18,2)), ('Ben', false, 5.00::DECIMAL(18,2)), ('Cara', true, 2.50::DECIMAL(18,2)), ('Dev', null, 1.00::DECIMAL(18,2))) as t(name, is_customer, spend)",
      [],
    );
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("groups and filters by a Yes/No column", async () => {
    const grouped = await runTile(ORG, {
      table: "people",
      groupBy: { field: "is_customer" },
      measures: [{ label: "Spend", aggregate: "sum", field: "spend" }],
      filters: [],
      dateField: null,
      sort: { by: "category", direction: "asc" },
      limit: null,
    });
    expect(grouped.columns[0]).toMatchObject({ key: "category", format: "boolean" });
    expect(grouped.rows.map((row) => [showValue(row.category, grouped.columns[0]), row.m0])).toEqual([
      ["No", "5.00"],
      ["Yes", "12.50"],
      ["", "1.00"],
    ]);
    const customers = await runTile(ORG, {
      table: "people",
      groupBy: null,
      measures: [{ label: "Spend", aggregate: "sum", field: "spend" }],
      filters: [{ field: "is_customer", op: "eq", value: "true" }],
      dateField: null,
      sort: { by: "category", direction: "asc" },
      limit: null,
    });
    expect(customers.rows).toEqual([{ m0: "12.50" }]);
    await expect(
      runTile(ORG, {
        table: "people",
        groupBy: null,
        measures: [{ label: "Spend", aggregate: "sum", field: "spend" }],
        filters: [{ field: "is_customer", op: "eq", value: "Yes" }],
        dateField: null,
        sort: { by: "category", direction: "asc" },
        limit: null,
      }),
    ).rejects.toThrow(/choose Yes or No/);
  });

  it("gives a slicer the column's type with its values", async () => {
    expect(await columnValues(ORG, "people", "is_customer")).toEqual({ values: ["false", "true"], type: "BOOLEAN" });
  });
});
