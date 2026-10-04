import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile, sliceValues } from "@/lib/analytics/dashboards";
import { closeAnalytics, loadCsv } from "@/lib/analytics/engine";
import { formatOfType } from "@/lib/analytics/query";
import { cmp, dec, sum } from "@/lib/money/decimal";

const ORG = "query-test";
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-query-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const folder = path.join(root, "src");
  fs.mkdirSync(folder);
  const file = path.join(folder, "sales.csv");
  fs.writeFileSync(
    file,
    [
      "date,region,customer,qty,price,cost",
      "2025-01-10,Otago,Alpha,1,0.10,0.05",
      "2025-01-20,Otago,Beta,1,0.20,0.10",
      "2025-02-03,Canterbury,Alpha,2,50.00,30.00",
      "2026-01-15,Otago,Alpha,3,0.10,0.05",
      "2026-01-16,Canterbury,Gamma,1,100.00,60.00",
      "2026-02-01,Canterbury,Beta,4,25.00,15.00",
      "2026-02-02,Otago,Beta,1,9.99,5.00",
    ].join("\n") + "\n",
  );
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file,
    table: "sales",
    columns: [
      { source: "date", name: "order_date", kind: "date" },
      { source: "region", name: "region", kind: "text" },
      { source: "customer", name: "customer", kind: "text" },
      { source: "qty", name: "quantity", kind: "quantity" },
      { source: "price", name: "unit_price", kind: "money" },
      { source: "cost", name: "cost", kind: "money" },
    ],
  });
  const pivotFile = path.join(folder, "pivot.csv");
  fs.writeFileSync(
    pivotFile,
    [
      "date,region,product,amount",
      "2025-01-10,Otago,Widgets,0.10",
      "2025-01-20,Otago,Widgets,0.20",
      "2025-01-21,Otago,Gadgets,999999999999999.99",
      "2025-02-05,Otago,Gadgets,0.01",
      "2025-01-25,Canterbury,Widgets,0.30",
      "2025-02-08,Canterbury,Widgets,0.10",
      "2025-02-09,Canterbury,Gadgets,0.20",
    ].join("\n") + "\n",
  );
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file: pivotFile,
    table: "pivot_sales",
    columns: [
      { source: "date", name: "date", kind: "date" },
      { source: "region", name: "region", kind: "text" },
      { source: "product", name: "product", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
    ],
  });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const sales = { label: "Sales", aggregate: "sum", field: "quantity", times: "unit_price" };

describe("analytics tile queries (step 3)", () => {
  it("adds up money exactly, by month, beside last year", async () => {
    const result = await runTile(
      ORG,
      {
        table: "sales",
        groupBy: { field: "order_date", grain: "month" },
        measures: [{ ...sales, compare: "previous_year" }],
        filters: [{ field: "region", op: "eq", value: "Otago" }],
        sort: { by: "category", direction: "asc" },
      },
      { from: "2026-01-01", to: "2026-12-31" },
    );
    expect(result.columns.map((column) => [column.key, column.format])).toEqual([
      ["category", "date"],
      ["m0", "money"],
      ["m0_py", "money"],
    ]);
    // Jan 2026: 3 x 0.10 = 0.30 (exactly), last year 0.10 + 0.20 = 0.30 (exactly, not 0.30000000000000004).
    expect(result.rows).toEqual([
      { category: "2026-01-01", m0: "0.300000", m0_py: "0.300000" },
      { category: "2026-02-01", m0: "9.990000", m0_py: null },
    ]);
  });

  it("gives the top customers with margin, largest first", async () => {
    const result = await runTile(ORG, {
      table: "sales",
      groupBy: { field: "customer" },
      measures: [sales, { label: "Cost", aggregate: "sum", field: "quantity", times: "cost" }, { label: "Orders", aggregate: "count" }],
      filters: [{ field: "order_date", op: "gte", value: "2026-01-01" }],
      sort: { by: "value", direction: "desc" },
      limit: 2,
    });
    expect(result.rows).toEqual([
      { category: "Beta", m0: "109.990000", m1: "65.000000", m2: "2" },
      { category: "Gamma", m0: "100.000000", m1: "60.000000", m2: "1" },
    ]);
  });

  it("totals without grouping (a KPI) and applies slicers", async () => {
    const all = await runTile(ORG, { table: "sales", groupBy: null, measures: [sales] });
    expect(all.rows).toEqual([{ m0: "310.590000" }]);
    const sliced = await runTile(ORG, { table: "sales", groupBy: null, measures: [sales] }, { values: { region: ["Canterbury"] } });
    expect(sliced.rows).toEqual([{ m0: "300.000000" }]);
    expect(await sliceValues(ORG, "sales", "region")).toEqual(["Canterbury", "Otago"]);
  });

  it("only accepts real columns and passes typed values as parameters", async () => {
    await expect(runTile(ORG, { table: "sales; drop table sales", groupBy: null, measures: [sales] })).rejects.toThrow(/no loaded table/);
    await expect(
      runTile(ORG, { table: "sales", groupBy: { field: 'region" from sales; --' }, measures: [sales] }),
    ).rejects.toThrow(/no column/);
    const injected = await runTile(ORG, {
      table: "sales",
      groupBy: null,
      measures: [{ label: "Rows", aggregate: "count" }],
      filters: [{ field: "region", op: "eq", value: "Otago' or '1'='1" }],
    });
    expect(injected.rows).toEqual([{ m0: "0" }]);
    await expect(
      runTile(ORG, { table: "sales", groupBy: null, measures: [sales], filters: [{ field: "unit_price", op: "gt", value: "1 or 1=1" }] }),
    ).rejects.toThrow(/isn't a number/);
    await expect(runTile(ORG, { table: "sales", groupBy: null, measures: [{ label: "x", aggregate: "sum", field: "region" }] })).rejects.toThrow(
      /isn't a number/,
    );
    const rows = await runTile(ORG, { table: "sales", groupBy: null, measures: [{ label: "n", aggregate: "count" }] });
    expect(rows.rows).toEqual([{ m0: "7" }]);
  });

  it("knows money columns from how they were loaded", () => {
    expect(formatOfType("DECIMAL(18,2)")).toBe("money");
    expect(formatOfType("DECIMAL(18,4)")).toBe("number");
    expect(formatOfType("BIGINT")).toBe("integer");
    expect(formatOfType("DATE")).toBe("date");
    expect(formatOfType("VARCHAR")).toBe("text");
  });

  it("pivots on one column with exact detail, subtotal, and grand totals", async () => {
    const result = await runTile(ORG, {
      table: "pivot_sales",
      pivot: {
        rows: [{ field: "region" }, { field: "product" }],
        column: { field: "date", grain: "quarter" },
      },
      measures: [
        { label: "Sales", aggregate: "sum", field: "amount" },
        { label: "Average", aggregate: "avg", field: "amount" },
      ],
      filters: [],
      dateField: "date",
      sort: { by: "category", direction: "asc" },
      limit: null,
    });

    expect(result.pivot?.columnValues).toEqual(["2025-01-01"]);
    expect(result.pivot?.columns.map(({ key, pivotValue, total }) => [key, pivotValue, total])).toEqual([
      ["c0_m0", "2025-01-01", false],
      ["c0_m1", "2025-01-01", false],
      ["total_m0", null, true],
      ["total_m1", null, true],
    ]);
    const row = (region: string, product: string) => result.pivot?.rows.find(
      (entry) => entry.kind === "detail" && entry.dimensions[0] === region && entry.dimensions[1] === product,
    );
    expect(row("Otago", "Widgets")?.cells).toEqual({ c0_m0: "0.30", c0_m1: "0.150000", total_m0: "0.30", total_m1: "0.150000" });
    expect(row("Otago", "Gadgets")?.cells).toEqual({
      c0_m0: "1000000000000000.00",
      c0_m1: "500000000000000.000000",
      total_m0: "1000000000000000.00",
      total_m1: "500000000000000.000000",
    });
    const otago = result.pivot?.rows.find((entry) => entry.kind === "subtotal" && entry.dimensions[0] === "Otago");
    expect(otago?.cells).toEqual({
      c0_m0: "1000000000000000.30",
      c0_m1: "250000000000000.075000",
      total_m0: "1000000000000000.30",
      total_m1: "250000000000000.075000",
    });
    expect(result.pivot?.rows.at(-1)).toMatchObject({
      kind: "grand_total",
      cells: { total_m0: "1000000000000000.90", total_m1: "142857142857142.985714" },
    });
  });

  it("orders pivot rows under their subtotals and columns by value, with totals equal to their rows", async () => {
    const file = path.join(root, "src", "order.csv");
    fs.writeFileSync(
      file,
      [
        "date,region,product,amount",
        "2025-02-05,Otago,Widgets,0.10",
        "2025-02-06,Otago,Widgets,0.20",
        "2025-02-07,Otago,Apples,999999999999999.99",
        "2025-01-03,Waikato,Widgets,0.10",
        "2025-02-03,Waikato,Apples,0.20",
        "2025-03-01,Canterbury,Widgets,0.30",
        "2025-01-09,Canterbury,Apples,0.01",
      ].join("\n") + "\n",
    );
    await loadCsv({
      organisationId: ORG,
      sourceFolder: path.dirname(file),
      file,
      table: "pivot_order",
      columns: [
        { source: "date", name: "date", kind: "date" },
        { source: "region", name: "region", kind: "text" },
        { source: "product", name: "product", kind: "text" },
        { source: "amount", name: "amount", kind: "money" },
      ],
    });
    const result = await runTile(ORG, {
      table: "pivot_order",
      pivot: { rows: [{ field: "region" }, { field: "product" }], column: { field: "date", grain: "month" } },
      measures: [
        { label: "Sales", aggregate: "sum", field: "amount" },
        { label: "Average", aggregate: "avg", field: "amount" },
      ],
      filters: [],
      dateField: "date",
      sort: { by: "value", direction: "desc" },
      limit: null,
    });
    const pivot = result.pivot!;
    // Columns in date order, whatever order the rows meet them in.
    expect(pivot.columnValues).toEqual(["2025-01-01", "2025-02-01", "2025-03-01"]);
    // Each region's rows, then its subtotal; the grand total last. Hidden value sorts are ignored.
    expect(pivot.rows.map((row) => [row.kind, ...row.dimensions.slice(0, row.depth)])).toEqual([
      ["detail", "Canterbury", "Apples"],
      ["detail", "Canterbury", "Widgets"],
      ["subtotal", "Canterbury"],
      ["detail", "Otago", "Apples"],
      ["detail", "Otago", "Widgets"],
      ["subtotal", "Otago"],
      ["detail", "Waikato", "Apples"],
      ["detail", "Waikato", "Widgets"],
      ["subtotal", "Waikato"],
      ["grand_total"],
    ]);
    // Sums: every subtotal and total is exactly the sum of the rows under it.
    const sumKeys = pivot.columns.filter((column) => column.measure.key === "m0").map((column) => column.key);
    const details = pivot.rows.filter((row) => row.kind === "detail");
    const exactSum = (rows: typeof details, key: string) => sum(rows.map((row) => dec(row.cells[key] ?? "0")));
    for (const key of sumKeys) {
      for (const subtotal of pivot.rows.filter((row) => row.kind === "subtotal")) {
        const under = details.filter((row) => row.dimensions[0] === subtotal.dimensions[0]);
        expect(cmp(dec(subtotal.cells[key] ?? "0"), exactSum(under, key))).toBe(0);
      }
      expect(cmp(dec(pivot.rows.at(-1)!.cells[key] ?? "0"), exactSum(details, key))).toBe(0);
    }
    const grand = pivot.rows.at(-1)!;
    expect(grand.cells.total_m0).toBe("1000000000000000.90");
    expect(grand.cells.c1_m0).toBe("1000000000000000.49");
    // Averages are over the underlying rows, not the average of averages.
    expect(grand.cells.total_m1).toBe("142857142857142.985714");
    expect(pivot.rows.find((row) => row.kind === "subtotal" && row.dimensions[0] === "Otago")!.cells.total_m1).toBe("333333333333333.430000");
    // Row totals across the columns add up too.
    for (const row of pivot.rows) {
      const across = sum(pivot.columns.filter((column) => !column.total && column.measure.key === "m0").map((column) => dec(row.cells[column.key] ?? "0")));
      expect(cmp(dec(row.cells.total_m0 ?? "0"), across)).toBe(0);
    }
  });

  it("limits the full pivot grid, including subtotal and total cells", async () => {
    const file = path.join(root, "src", "wide.csv");
    const pairs = Array.from({ length: 45 }, (_, index) => `Row ${index},Column ${index},1.00`);
    fs.writeFileSync(file, `row_name,column_name,amount\n${pairs.join("\n")}\n`);
    await loadCsv({
      organisationId: ORG,
      sourceFolder: path.dirname(file),
      file,
      table: "wide",
      columns: [
        { source: "row_name", name: "row_name", kind: "text" },
        { source: "column_name", name: "column_name", kind: "text" },
        { source: "amount", name: "amount", kind: "money" },
      ],
    });
    await expect(
      runTile(ORG, {
        table: "wide",
        pivot: { rows: [{ field: "row_name" }], column: { field: "column_name" } },
        measures: [{ label: "Amount", aggregate: "sum", field: "amount" }],
        filters: [],
        dateField: null,
        sort: { by: "category", direction: "asc" },
        limit: null,
      }),
    ).rejects.toThrow("Too many rows and columns; filter or group further");
  });

  it("supports a pivot without a column field", async () => {
    const result = await runTile(ORG, {
      table: "pivot_sales",
      pivot: { rows: [{ field: "region" }], column: null },
      measures: [{ label: "Sales", aggregate: "sum", field: "amount" }],
      filters: [],
      dateField: null,
      sort: { by: "category", direction: "asc" },
      limit: null,
    });
    expect(result.pivot?.columnField).toBeNull();
    expect(result.pivot?.columns.map((column) => column.key)).toEqual(["m0"]);
    expect(result.pivot?.rows.at(-1)).toMatchObject({ kind: "grand_total", cells: { m0: "1000000000000000.90" } });
  });
});
