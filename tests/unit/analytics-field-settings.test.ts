import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { checkSortBy, parseFieldSettings, withFieldSettings, type SavedFieldSettings } from "@/lib/analytics/field-settings";
import { showValue } from "@/lib/analytics/display";
import { withRelationships } from "@/lib/analytics/relationships";
import { tileChartSpec } from "@/lib/analytics/tile-chart";

/** Field settings (#376 phase 4, decision 775; examples FS1-FS4). Made-up data. */

const ORG = "field-settings-test";
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-fs-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const folder = path.join(root, "src");
  fs.mkdirSync(folder);
  const file = path.join(folder, "sales.csv");
  // A financial year's months by name, with their place in a 1 April year (April is 1).
  fs.writeFileSync(
    file,
    ["month_name,fy_month,region,amount", "Apr,1,North,100.00", "May,2,North,50.00", "Jan,10,South,30.00", "Mar,12,South,20.00", "Feb,11,North,1000.00", "Feb,11,South,0.50"].join("\n") + "\n",
  );
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file,
    table: "sales",
    columns: [
      { source: "month_name", name: "month_name", kind: "text" },
      { source: "fy_month", name: "fy_month", kind: "integer" },
      { source: "region", name: "region", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
    ] as never,
  });
  const bad = path.join(folder, "bad.csv");
  fs.writeFileSync(bad, ["month_name,fy_month", "Apr,1", "Apr,13"].join("\n") + "\n");
  await loadCsv({ organisationId: ORG, sourceFolder: folder, file: bad, table: "bad", columns: [{ source: "month_name", name: "month_name", kind: "text" }, { source: "fy_month", name: "fy_month", kind: "integer" }] as never });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const saved: SavedFieldSettings[] = [
  { table: "sales", field: "month_name", settings: { sortBy: "fy_month", folder: "Dates", description: "The month's short name." } },
  { table: "sales", field: "amount", settings: { number: { style: "currency", decimals: 0 }, summarise: "sum", folder: "Money" } },
  { table: "sales", field: "fy_month", settings: { summarise: "none" } },
];
const model = { fields: [], relationships: [], fieldSettings: saved };
const byMonth = (extra: Record<string, unknown> = {}) => ({
  table: "sales",
  groupBy: { field: "month_name" },
  measures: [{ label: "Sales", aggregate: "sum", field: "amount" }],
  filters: [],
  dateField: null,
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});

describe("FS1: sort a field by another column", () => {
  it("orders month names by the financial year's month number, either way", async () => {
    const result = await runTile(ORG, byMonth(), {}, { model });
    expect(result.rows.map((row) => row.category)).toEqual(["Apr", "May", "Jan", "Feb", "Mar"]);
    expect(Object.keys(result.rows[0])).toEqual(["category", "m0"]);
    const newest = await runTile(ORG, byMonth({ sort: { by: "category", direction: "desc" } }), {}, { model });
    expect(newest.rows.map((row) => row.category)).toEqual(["Mar", "Feb", "Jan", "May", "Apr"]);
    // Without the setting, A to Z.
    const plain = await runTile(ORG, byMonth(), {});
    expect(plain.rows.map((row) => row.category)).toEqual(["Apr", "Feb", "Jan", "Mar", "May"]);
  });

  it("runs a running total in that order, and value order still wins when chosen", async () => {
    const running = await runTile(ORG, byMonth({ measures: [{ label: "Sales", aggregate: "sum", field: "amount", quick: "running_total" }] }), {}, { model });
    expect(running.rows.map((row) => [row.category, row.m0])).toEqual([
      ["Apr", "100.00"],
      ["May", "150.00"],
      ["Jan", "180.00"],
      ["Feb", "1180.50"],
      ["Mar", "1200.50"],
    ]);
    const biggest = await runTile(ORG, byMonth({ sort: { by: "value", direction: "desc" }, limit: 1 }), {}, { model });
    expect(biggest.rows).toEqual([{ category: "Feb", m0: "1000.50" }]);
  });

  it("needs one sort value for each value, checked on the data", async () => {
    const tables = await listTables(ORG);
    await expect(checkSortBy(ORG, "bad", tables.get("bad")!, "month_name", "fy_month")).rejects.toThrow(/"Apr" has 2 different fy month values/);
    await expect(checkSortBy(ORG, "sales", tables.get("sales")!, "month_name", "fy_month")).resolves.toBeUndefined();
  });
});

describe("FS2: a field's own format and summary", () => {
  it("shows a value in its field's format unless the chart chose one", async () => {
    const result = await runTile(ORG, byMonth(), {}, { model });
    const column = result.columns.find((entry) => entry.key === "m0")!;
    expect(column.number).toEqual({ style: "currency", decimals: 0 });
    expect(showValue("1000.50", column)).toBe("$1,001");
    expect(showValue("1000.50", { format: "money" })).toBe("$1,000.50");
    const spec = tileChartSpec({ visual: "column" }, [column]);
    expect(spec?.series[0].number).toEqual({ style: "currency", decimals: 0 });
    // A count or a share isn't in the amount's format.
    const counted = await runTile(ORG, byMonth({ measures: [{ label: "Rows", aggregate: "count", field: "amount" }, { label: "Share", aggregate: "sum", field: "amount", quick: "percent_of_total" }] }), {}, { model });
    expect(counted.columns.filter((entry) => entry.role === "measure").map((entry) => entry.number)).toEqual([undefined, undefined]);
  });

  it("checks settings against the field", async () => {
    const columns = (await listTables(ORG)).get("sales")!;
    const field = (name: string) => columns.find((column) => column.name === name)!;
    expect(() => parseFieldSettings({ summarise: "sum" }, field("region"), columns)).toThrow(/isn't a number/);
    expect(() => parseFieldSettings({ summarise: "median" }, field("amount"), columns)).toThrow(/from the list/);
    expect(() => parseFieldSettings({ sortBy: "region" }, field("region"), columns)).toThrow(/sorted by itself/);
    expect(() => parseFieldSettings({ sortBy: "nope" }, field("region"), columns)).toThrow(/no column called nope/);
    expect(() => parseFieldSettings({ folder: "x".repeat(41) }, field("region"), columns)).toThrow(/40 characters/);
    expect(() => parseFieldSettings({ number: { style: "fancy" } }, field("amount"), columns)).toThrow();
    expect(parseFieldSettings({ summarise: "none", folder: " Dates ", colour: "red" }, field("fy_month"), columns)).toEqual({ summarise: "none", folder: "Dates" });
    expect(() => parseFieldSettings({ sortBy: "fy_month" }, { name: "sale_date", type: "DATE" }, columns)).toThrow(/already in date order/);
  });
});

describe("FS3: folders and descriptions travel with the columns", () => {
  it("adds settings to a table's columns, and a related table's fields keep theirs", async () => {
    const tables = withFieldSettings(await listTables(ORG), saved);
    expect(tables.get("sales")!.find((column) => column.name === "month_name")?.settings).toEqual({ sortBy: "fy_month", folder: "Dates", description: "The month's short name." });
    const related = withRelationships(new Map([...tables, ["orders", [{ name: "month", type: "VARCHAR" }]]]), [{ id: "1", table: "orders", field: "month", dimension: "sales", dimensionField: "region", name: "sale" }]);
    expect(related.get("orders")!.find((column) => column.name === "sale.month_name")?.settings?.sortBy).toBe("sale.fy_month");
  });

  it("drops a sort column that has gone from the table", () => {
    const tables = withFieldSettings(new Map([["sales", [{ name: "month_name", type: "VARCHAR" }]]]), saved);
    expect(tables.get("sales")![0].settings).toEqual({ folder: "Dates", description: "The month's short name." });
  });
});
