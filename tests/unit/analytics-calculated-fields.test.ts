import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileField, withFields, type CalculatedField } from "@/lib/analytics/calculated-fields";
import { runPivotDrilldown, runTile, columnValues } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { parseFieldFormula } from "@/lib/analytics/formula";
import { parseTileQuery, type ColumnInfo } from "@/lib/analytics/query";

/** Calculated fields on a data source (#376 phase 4, decision 772; examples CF1-CF6). Made-up data. */

const ORG = "calculated-field-test";
let root: string;
let columns: ColumnInfo[];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-fields-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const folder = path.join(root, "src");
  fs.mkdirSync(folder);
  const file = path.join(folder, "lines.csv");
  fs.writeFileSync(
    file,
    [
      "date,customer,region,quantity,unit_price,amount",
      "2026-03-31,Kererū Café,north,2,12.50,25.00",
      "2026-04-01,Tūī Books,south,10,150.00,1500.00",
      "2026-04-15,O'Neill's,north,1,999.99,999.99",
      "2026-07-02,Tūī Books,,4,250.00,1000.00",
      "2028-02-29,Kererū Café,south,,,",
    ].join("\n") + "\n",
  );
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file,
    table: "lines",
    columns: [
      { source: "date", name: "sale_date", kind: "date" },
      { source: "customer", name: "customer", kind: "text" },
      { source: "region", name: "region", kind: "text" },
      { source: "quantity", name: "quantity", kind: "integer" },
      { source: "unit_price", name: "unit_price", kind: "money" },
      { source: "amount", name: "amount", kind: "money" },
    ] as never,
  });
  columns = (await listTables(ORG)).get("lines")!;
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const field = (name: string, formula: string, yearEnd = 3): CalculatedField => {
  const compiled = compileField(formula, columns, yearEnd);
  const type = { money: "DECIMAL(38,2)", number: "DECIMAL(38,6)", integer: "BIGINT", text: "VARCHAR", date: "DATE", boolean: "BOOLEAN" }[compiled.kind];
  return { id: name, table: "lines", name, formula, description: null, type, sql: compiled.sql };
};
const grouped = (by: string, measures: unknown[] = [{ label: "Sales", aggregate: "sum", field: "amount" }], extra: Record<string, unknown> = {}) => ({
  table: "lines",
  groupBy: { field: by },
  measures,
  filters: [],
  dateField: "sale_date",
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});

describe("CF1: IF and CASE make groups", () => {
  it("groups and adds up by a calculated band", async () => {
    const fields = [field("size_band", 'CASE WHEN [amount] >= 1000 THEN "Large" WHEN [amount] >= 100 THEN "Medium" WHEN IS_BLANK([amount]) THEN "No amount" ELSE "Small" END')];
    const result = await runTile(ORG, grouped("size_band"), {}, { fields });
    expect(result.rows.map((row) => [row.category, row.m0])).toEqual([
      ["Large", "2500.00"],
      ["Medium", "999.99"],
      ["No amount", null],
      ["Small", "25.00"],
    ]);
  });

  it("filters by one, and a blank value takes the ELSE", async () => {
    const fields = [field("is_north", 'IF([region] = "north", TRUE, FALSE)')];
    const result = await runTile(ORG, { ...grouped("customer"), filters: [{ field: "is_north", op: "eq", value: "true" }] }, {}, { fields });
    expect(result.rows.map((row) => [row.category, row.m0])).toEqual([
      ["Kererū Café", "25.00"],
      ["O'Neill's", "999.99"],
    ]);
  });
});

describe("CF2: arithmetic stays exact, and money stays money", () => {
  it("multiplies and adds without floats", async () => {
    const fields = [field("line_total", "[quantity] * [unit_price]"), field("with_fee", "[amount] + 0.10"), field("share", "[amount] / 3")];
    const tables = withFields(await listTables(ORG), fields);
    expect(tables.get("lines")!.filter((column) => column.expression).map((column) => column.type)).toEqual(["DECIMAL(38,6)", "DECIMAL(38,2)", "DECIMAL(38,6)"]);
    const result = await runTile(
      ORG,
      { ...grouped("customer", [{ label: "Lines", aggregate: "sum", field: "line_total" }, { label: "With fee", aggregate: "sum", field: "with_fee" }, { label: "Thirds", aggregate: "sum", field: "share" }]), filters: [{ field: "customer", op: "eq", value: "O'Neill's" }] },
      {},
      { fields },
    );
    expect(result.rows[0]).toMatchObject({ m0: "999.990000", m1: "1000.09", m2: "333.330000" });
    expect(result.columns.map((column) => column.format)).toEqual(["text", "number", "money", "number"]);
  });

  it("is blank when a value it uses is blank, and dividing by zero is blank", async () => {
    const fields = [field("per_unit", "[amount] / [quantity]"), field("over_zero", "[amount] / 0")];
    const result = await runTile(ORG, { ...grouped("sale_date", [{ label: "Per unit", aggregate: "max", field: "per_unit" }, { label: "Zero", aggregate: "max", field: "over_zero" }]), groupBy: { field: "sale_date", grain: "day" } }, {}, { fields });
    expect(result.rows.find((row) => row.category === "2028-02-29")).toMatchObject({ m0: null, m1: null });
    expect(result.rows.find((row) => row.category === "2026-04-01")).toMatchObject({ m0: "150.000000", m1: null });
  });
});

describe("CF3: date parts follow the balance date", () => {
  it("names financial years by the year they end and quarters from the balance date", async () => {
    const fields = [field("fy", "FINANCIAL_YEAR([sale_date])"), field("fq", "FINANCIAL_QUARTER([sale_date])"), field("month_name", "MONTH_NAME([sale_date])")];
    const result = await runTile(ORG, grouped("fy", [{ label: "Rows", aggregate: "count" }]), {}, { fields });
    // 31 March 2026 is FY2026; 1 April 2026 starts FY2027; 29 February 2028 is in FY2028.
    expect(result.rows.map((row) => [row.category, row.m0])).toEqual([
      ["2026", "1"],
      ["2027", "3"],
      ["2028", "1"],
    ]);
    const quarters = await runTile(ORG, grouped("fq", [{ label: "Rows", aggregate: "count" }]), {}, { fields });
    expect(quarters.rows.map((row) => [row.category, row.m0])).toEqual([
      ["1", "2"],
      ["2", "1"],
      ["4", "2"],
    ]);
    const june = [field("fy", "FINANCIAL_YEAR([sale_date])", 6), field("fq", "FINANCIAL_QUARTER([sale_date])", 6)];
    const byJune = await runTile(ORG, grouped("fy", [{ label: "Rows", aggregate: "count" }]), {}, { fields: june });
    // With a 30 June balance date, 2 July 2026 starts FY2027; the rest to 30 June 2026 are FY2026.
    expect(byJune.rows.map((row) => [row.category, row.m0])).toEqual([
      ["2026", "3"],
      ["2027", "1"],
      ["2028", "1"],
    ]);
    const names = await columnValues(ORG, "lines", "month_name", fields);
    expect(names.values).toEqual(["Apr", "Feb", "Jul", "Mar"]);
  });

  it("counts days between dates", () => {
    expect(compileField("DAYS_BETWEEN([sale_date], [sale_date])", columns, 3).kind).toBe("integer");
  });
});

describe("CF4: text functions", () => {
  it("joins, cuts, changes case and tests text, including quotes and macrons", async () => {
    const fields = [field("label", 'CONCAT(UPPER(LEFT([customer], 3)), " - ", IFBLANK([region], "none"))'), field("has_books", 'CONTAINS([customer], "books")')];
    const result = await runTile(ORG, grouped("label", [{ label: "Rows", aggregate: "count" }]), {}, { fields });
    expect(result.rows.map((row) => row.category)).toEqual(["KER - north", "KER - south", "O'N - north", "TŪĪ - none", "TŪĪ - south"]);
    const books = await runTile(ORG, grouped("has_books", [{ label: "Rows", aggregate: "count" }]), {}, { fields });
    expect(books.rows.map((row) => [row.category, row.m0])).toEqual([
      ["false", "3"],
      ["true", "2"],
    ]);
  });

  it("keeps typed text as text, never as SQL", async () => {
    const fields = [field("odd", `IF([customer] = "x'); drop table lines; --", "matched", "safe")`)];
    const result = await runTile(ORG, grouped("odd", [{ label: "Rows", aggregate: "count" }]), {}, { fields });
    expect(result.rows).toEqual([{ category: "safe", m0: "5" }]);
    expect((await listTables(ORG)).has("lines")).toBe(true);
  });
});

describe("CF5: types are checked before it's saved", () => {
  const bad: Array<[string, RegExp]> = [
    ['[amount] + "x"', /CONCAT to join text/],
    ["[customer] * 2", /needs a number, not text/],
    ['IF([amount] > 10, "big", 5)', /same kind/],
    ["[missing] + 1", /no column called \[missing\]/],
    ["YEAR([customer])", /needs a date/],
    ["[sale_date] > \"soon\"", /YYYY-MM-DD/],
    ["SQRT([amount])", /isn't a function/],
    ["IF([amount])", /takes 2 to 3 values/],
    ["LEFT([customer], [quantity])", /whole number/],
    ["[amount] = BLANK", /IS_BLANK/],
    ["BLANK", /always blank/],
    ["[amount] >", /stops too early/],
    ['"unclosed', /isn't closed/],
    ["[amount]; select 1", /can't have ";"/],
  ];
  it.each(bad)("refuses %s", (formula, message) => {
    expect(() => compileField(formula, columns, 3)).toThrow(message);
  });

  it("can't use another calculated field", () => {
    const tables = withFields(new Map([["lines", columns]]), [field("band", 'IF([amount] > 1, "a", "b")')]);
    expect(() => compileField("UPPER([band])", tables.get("lines")!, 3)).toThrow(/can't use another calculated field/);
  });

  it("parses CASE, AND, OR and NOT into a tree", () => {
    expect(parseFieldFormula('CASE WHEN NOT [a] > 1 AND [b] = "x" OR TRUE THEN 1 END')).toMatchObject({ kind: "case", whens: [{ when: { kind: "logic", op: "or" } }], otherwise: null });
  });
});

describe("CF6: a tile uses a field like a column, and only through its table", () => {
  it("is checked as one of the table's columns and drills through", async () => {
    const fields = [field("size_band", 'IF([amount] >= 1000, "Large", "Small")')];
    const tables = withFields(await listTables(ORG), fields);
    expect(parseTileQuery(grouped("size_band"), tables).groupBy).toEqual({ field: "size_band" });
    const plain = await listTables(ORG);
    expect(() => parseTileQuery(grouped("size_band"), plain)).toThrow(/no column called size_band/);
    const pivot = { ...grouped("size_band"), groupBy: null, pivot: { rows: [{ field: "size_band" }], column: null } };
    const drill = await runPivotDrilldown(ORG, pivot, {}, { depth: 1, dimensions: ["Large"], pivotValue: null, total: false }, fields);
    expect(drill.rows.map((row) => row.d0)).toEqual(["Large", "Large"]);
  });
});
