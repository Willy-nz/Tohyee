import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile, sliceValues } from "@/lib/analytics/dashboards";
import { closeAnalytics, loadCsv } from "@/lib/analytics/engine";
import { formatOfType } from "@/lib/analytics/query";

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
});
