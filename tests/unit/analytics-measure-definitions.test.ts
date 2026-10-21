import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { tableTotals } from "@/lib/analytics/conditional";
import { describeMeasure, rowMeaning } from "@/lib/analytics/measure-definition";
import { parseTileQuery } from "@/lib/analytics/query";

/** Measure definitions (#387, decisions 694-696; examples MD1-MD3 and MD6). Made-up data. */

const ORG = "measure-definition-test";
let root: string;

async function load(name: string, header: string, rows: string[], columns: Array<{ source: string; name: string; kind: string }>) {
  const folder = path.join(root, "src");
  const file = path.join(folder, `${name}.csv`);
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  await loadCsv({ organisationId: ORG, sourceFolder: folder, file, table: name, columns: columns as never });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-measures-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  fs.mkdirSync(path.join(root, "src"));
  // MD1: two regions, margins 10/100 and 90/300.
  await load("margins", "date,region,sales,gross_profit", ["2026-06-10,North,100.00,10.00", "2026-06-11,South,300.00,90.00"], [
    { source: "date", name: "sale_date", kind: "date" },
    { source: "region", name: "region", kind: "text" },
    { source: "sales", name: "sales", kind: "money" },
    { source: "gross_profit", name: "gross_profit", kind: "money" },
  ]);
  // MD2: bank balances recorded each day for two accounts.
  await load(
    "balances",
    "date,account,balance",
    ["2026-06-01,Main,1000.00", "2026-06-02,Main,1200.00", "2026-06-30,Main,900.00", "2026-06-30,Savings,5000.00", "2026-07-15,Main,700.00"],
    [
      { source: "date", name: "balance_date", kind: "date" },
      { source: "account", name: "account", kind: "text" },
      { source: "balance", name: "balance", kind: "money" },
    ],
  );
  // MD3: invoices in two currencies, with the amount in NZD at each invoice's rate.
  await load("fx_invoices", "number,date,currency,foreign_total,total", ["INV-1,2026-06-01,USD,100.00,160.00", "INV-2,2026-06-02,AUD,50.00,55.00", "INV-3,2026-06-03,USD,20.00,32.00"], [
    { source: "number", name: "number", kind: "text" },
    { source: "date", name: "invoice_date", kind: "date" },
    { source: "currency", name: "currency", kind: "text" },
    { source: "foreign_total", name: "foreign_total", kind: "money" },
    { source: "total", name: "total", kind: "money" },
  ]);
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const margin = { label: "Margin", aggregate: "formula", formula: "[Gross profit] / [Sales]" };
const sales = { label: "Sales", aggregate: "sum", field: "sales" };
const profit = { label: "Gross profit", aggregate: "sum", field: "gross_profit" };

describe("MD1: ratios are worked out from the totals", () => {
  it("gives 10% and 30% by region and 25% in total, not the 20% average", async () => {
    const byRegion = await runTile(ORG, { table: "margins", groupBy: { field: "region" }, measures: [sales, profit, margin], filters: [], sort: { by: "category", direction: "asc" } }, {}, { totals: true });
    expect(byRegion.rows.map((row) => [row.category, row.m2])).toEqual([
      ["North", "0.100000"],
      ["South", "0.300000"],
    ]);
    expect(byRegion.totals).toMatchObject({ m0: "400.00", m1: "100.00", m2: "0.250000" });
    // The table's totals row uses them; without them a calculated value is left blank rather than added up.
    expect(tableTotals(byRegion.columns, byRegion.rows, ["sum", "sum", "formula"], byRegion.totals).m2).toBe("0.250000");
    expect(tableTotals(byRegion.columns, byRegion.rows, ["sum", "sum", "formula"]).m2).toBeNull();
    // A key figure (one total) is the same.
    const one = await runTile(ORG, { table: "margins", groupBy: null, measures: [sales, profit, margin], filters: [], sort: { by: "category", direction: "asc" } });
    expect(one.rows[0].m2).toBe("0.250000");
    // An average of a value is of all the rows, not of the groups' averages.
    const average = await runTile(ORG, { table: "margins", groupBy: { field: "region" }, measures: [{ label: "Average sale", aggregate: "avg", field: "sales" }], filters: [], sort: { by: "category", direction: "asc" } }, {}, { totals: true });
    expect(average.totals?.m0).toBe("200.000000");
  });

  it("leaves the totals to the rows shown when the tile has a Top N", async () => {
    const top = await runTile(ORG, { table: "margins", groupBy: { field: "region" }, measures: [sales, profit, margin], filters: [], sort: { by: "value", direction: "desc" }, limit: 1 }, {}, { totals: true });
    expect(top.totals).toBeUndefined();
  });
});

describe("MD2: a balance recorded each day isn't added across dates", () => {
  const snapshot = { label: "Bank balance", aggregate: "sum", field: "balance", snapshot: { per: "account" } };

  it("takes each account's latest balance in the month and adds those", async () => {
    const byMonth = await runTile(ORG, {
      table: "balances",
      groupBy: { field: "balance_date", grain: "month" },
      measures: [snapshot, { label: "Every row added", aggregate: "sum", field: "balance" }],
      filters: [],
      sort: { by: "category", direction: "asc" },
    });
    // June: Main 900.00 (30 June) + Savings 5,000.00; adding every row would give 8,100.00.
    // July: only Main has a balance recorded in July (700.00); a month counts the balances recorded in it.
    expect(byMonth.rows).toEqual([
      { category: "2026-06-01", m0: "5900.00", m1: "8100.00" },
      { category: "2026-07-01", m0: "700.00", m1: "700.00" },
    ]);
  });

  it("as one figure, is each account's latest balance up to the To date", async () => {
    const atTo = await runTile(ORG, { table: "balances", groupBy: null, measures: [snapshot], filters: [], dateField: "balance_date", sort: { by: "category", direction: "asc" } }, { from: "2026-06-01", to: "2026-07-31" });
    // Main 700.00 (15 July) + Savings 5,000.00 (30 June).
    expect(atTo.rows[0].m0).toBe("5700.00");
    const june = await runTile(ORG, { table: "balances", groupBy: null, measures: [snapshot], filters: [], dateField: "balance_date", sort: { by: "category", direction: "asc" } }, { from: "2026-06-01", to: "2026-06-30" });
    expect(june.rows[0].m0).toBe("5900.00");
  });

  it("is refused where it can't be worked out yet", async () => {
    const tables = await listTables(ORG);
    expect(() => parseTileQuery({ table: "balances", groupBy: null, measures: [{ ...snapshot, aggregate: "avg" }], filters: [], dateField: "balance_date" }, tables)).toThrow(/total of the latest balances/);
    expect(() => parseTileQuery({ table: "balances", groupBy: { field: "account" }, measures: [snapshot], filters: [] }, tables)).toThrow(/needs the date it was recorded/);
    expect(() =>
      parseTileQuery({ table: "balances", groupBy: null, pivot: { rows: [{ field: "account" }], column: null }, measures: [snapshot], filters: [], dateField: "balance_date" }, tables),
    ).toThrow(/pivot/);
  });
});

describe("MD3: amounts in different currencies aren't added together", () => {
  const foreign = { label: "Foreign total", aggregate: "sum", field: "foreign_total" };
  const nzd = { label: "Total (NZD)", aggregate: "sum", field: "total" };

  it("leaves a total across currencies blank, with a note, and keeps the NZD amount", async () => {
    const one = await runTile(ORG, { table: "fx_invoices", groupBy: null, measures: [foreign, nzd], filters: [], sort: { by: "category", direction: "asc" } });
    expect(one.rows).toEqual([{ m0: null, m1: "247.00" }]);
    expect(one.notes).toEqual([
      "Foreign total has amounts in more than one currency, so they aren't added together: it's blank where they'd mix. Group or filter by the currency, or use the amount in the organisation's currency.",
    ]);
  });

  it("adds each currency up on its own when grouped or filtered by it", async () => {
    const byCurrency = await runTile(ORG, { table: "fx_invoices", groupBy: { field: "currency" }, measures: [foreign], filters: [], sort: { by: "category", direction: "asc" } }, {}, { totals: true });
    expect(byCurrency.rows).toEqual([
      { category: "AUD", m0: "50.00" },
      { category: "USD", m0: "120.00" },
    ]);
    // The totals row across them is blank.
    expect(byCurrency.totals).toEqual({ m0: null });
    const usd = await runTile(ORG, { table: "fx_invoices", groupBy: null, measures: [foreign], filters: [{ field: "currency", op: "eq", value: "USD" }], sort: { by: "category", direction: "asc" } });
    expect(usd.rows[0].m0).toBe("120.00");
    expect(usd.notes).toBeUndefined();
  });

  it("blanks a pivot's grand total across currencies", async () => {
    const pivot = await runTile(ORG, { table: "fx_invoices", groupBy: null, pivot: { rows: [{ field: "currency" }], column: null }, measures: [foreign], filters: [], sort: { by: "category", direction: "asc" } });
    const cells = pivot.pivot!.rows.map((row) => [row.kind, row.dimensions[0], row.cells.m0]);
    expect(cells).toEqual([
      ["detail", "AUD", "50.00"],
      ["detail", "USD", "120.00"],
      ["grand_total", null, null],
    ]);
    expect(pivot.notes).toHaveLength(1);
  });

  it("can name the currency column on any table", async () => {
    const tables = await listTables(ORG);
    const parsed = parseTileQuery({ table: "fx_invoices", groupBy: null, measures: [{ label: "Total", aggregate: "sum", field: "total", currencyField: "currency" }], filters: [] }, tables);
    expect(parsed.measures[0].currencyField).toBe("currency");
    expect(() => parseTileQuery({ table: "fx_invoices", groupBy: null, measures: [{ label: "Total", aggregate: "sum", field: "total", currencyField: "invoice_date" }], filters: [] }, tables)).toThrow(/isn't text/);
  });
});

describe("MD6: blanks, zero and dividing by zero", () => {
  it("gives no value for no rows, 0 for a count, and no value for dividing by zero", async () => {
    const none = await runTile(ORG, {
      table: "margins",
      groupBy: null,
      measures: [sales, { label: "Rows", aggregate: "count" }, { label: "Per row", aggregate: "formula", formula: "[Sales] / [Rows]" }],
      filters: [{ field: "region", op: "eq", value: "Nowhere" }],
      sort: { by: "category", direction: "asc" },
    });
    expect(none.rows[0]).toEqual({ m0: null, m1: "0", m2: null });
  });
});

describe("what a value means (decision 696)", () => {
  it("says what a row is, how it's added up, its unit, kind, dates, blanks and totals", async () => {
    const tables = await listTables(ORG);
    const columns = tables.get("fx_invoices")!;
    expect(describeMeasure({ label: "Foreign total", aggregate: "sum", field: "foreign_total" }, "fx_invoices", columns, "invoice_date")).toEqual({
      row: "one row of fx_invoices, as it was loaded",
      aggregation: "the total of foreign total",
      unit: "money, in each row's currency (amounts in different currencies aren't added together)",
      kind: "a movement: the rows in the dates",
      date: "goes by invoice date",
      blanks: "rows with no value are left out; with no rows at all it's blank, not 0",
      totals: "totals add the rows up exactly",
    });
    expect(describeMeasure({ ...margin, aggregate: "formula" }, "margins", tables.get("margins")!, "sale_date").totals).toMatch(/25%, not the average 20%/);
    expect(describeMeasure({ label: "Bank", aggregate: "sum", field: "balance", snapshot: { per: "account" } }, "balances", tables.get("balances")!, "balance_date").kind).toMatch(
      /latest row in each period for each account, added up; never added across dates/,
    );
    expect(describeMeasure({ label: "Cash", aggregate: "sum", field: "amount", asAt: true }, "tohyee_ledger_lines", [{ name: "amount", type: "DECIMAL(18,2)" }], "posting_date")).toMatchObject({
      row: "one posted journal line (one side of a journal)",
      unit: "money, in NZD",
      kind: "a balance: every row up to the To date, whatever the From date",
    });
    expect(rowMeaning("tohyee_invoices")).toBe("one approved or voided sales invoice (never a draft)");
  });
});
