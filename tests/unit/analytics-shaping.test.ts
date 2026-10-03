import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { describe, expect, it } from "vitest";
import { closeAnalytics, listTables, loadCsv, replaceTableFromSelect, runBuiltQuery } from "@/lib/analytics/engine";
import { buildShapeQuery } from "@/lib/analytics/shaping";

const ORG = "shaping-query-test";
let root: string;
let folder: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-shaping-"));
  folder = path.join(root, "source");
  fs.mkdirSync(folder);
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const orders = path.join(folder, "orders.csv");
  fs.writeFileSync(orders, "region,amount,q1,q2\nWest-A,0.10,0.10,0.20\nWest-A,0.20,0.20,0.30\nEast-B,1.00,1.00,2.00\n");
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file: orders,
    table: "orders",
    columns: [
      { source: "region", name: "region", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
      { source: "q1", name: "q1", kind: "money" },
      { source: "q2", name: "q2", kind: "money" },
    ],
  });
  const lookup = path.join(folder, "lookup.csv");
  fs.writeFileSync(lookup, "code,label\nWest,Western\nNorth,Northern\n");
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file: lookup,
    table: "lookup",
    columns: [
      { source: "code", name: "code", kind: "text" },
      { source: "label", name: "label", kind: "text" },
    ],
  });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const tables = new Map([
  [
    "orders",
    [
      { name: "region", type: "VARCHAR" },
      { name: "amount", type: "DECIMAL(18,2)" },
      { name: "q1", type: "DECIMAL(18,2)" },
      { name: "q2", type: "DECIMAL(18,2)" },
    ],
  ],
  ["lookup", [{ name: "code", type: "VARCHAR" }, { name: "label", type: "VARCHAR" }]],
]);

describe("analytics shaping query builder", () => {
  it("builds each applied step from the columns that exist at that point", () => {
    const result = buildShapeQuery({
      baseTable: "orders",
      tables,
      steps: [
        { type: "filter", column: "region", test: "contains", value: "x' OR 1=1 --" },
        { type: "columns", action: "keep", columns: ["region", "amount", "q1", "q2"] },
        { type: "rename", column: "region", name: "area" },
        { type: "type", column: "amount", kind: "money" },
        { type: "split", column: "area", separator: "-", names: ["zone", "district"] },
        { type: "unpivot", columns: ["q1", "q2"], attributeName: "attribute", valueName: "value" },
        {
          type: "group",
          by: ["zone"],
          aggregates: [
            { operation: "sum", column: "value", name: "total" },
            { operation: "average", column: "value", name: "average" },
            { operation: "count", name: "rows" },
            { operation: "smallest", column: "value", name: "smallest" },
            { operation: "largest", column: "value", name: "largest" },
          ],
        },
        {
          type: "calculated",
          name: "adjusted",
          expression: { type: "arithmetic", left: { type: "column", name: "total" }, operator: "/", right: { type: "number", value: "2" } },
        },
        {
          type: "calculated",
          name: "caption",
          expression: { type: "text", parts: [{ type: "column", name: "zone" }, { type: "text", value: " area" }] },
        },
        {
          type: "merge",
          table: "lookup",
          join: "left",
          matches: [{ column: "zone", withColumn: "code" }],
          columns: [{ column: "label", name: "zone_label" }],
        },
        { type: "append", table: "lookup" },
      ],
    });

    expect(result.sql).toContain("DECIMAL(38,6)");
    expect(result.sql).toContain("union all by name");
    expect(result.sql).not.toContain("x' OR 1=1 --");
    expect(result.params).toContain("x' OR 1=1 --");
    expect(result.columns.map((column) => column.name)).toEqual([
      "zone",
      "total",
      "average",
      "rows",
      "smallest",
      "largest",
      "adjusted",
      "caption",
      "zone_label",
      "code",
      "label",
    ]);
  });

  it("rejects names that are not present at the step and SQL-shaped names", () => {
    expect(() =>
      buildShapeQuery({
        baseTable: "orders",
        tables,
        steps: [{ type: "filter", column: 'region"; drop table orders; --', test: "is", value: "x" }],
      }),
    ).toThrow(/column/);

    expect(() =>
      buildShapeQuery({
        baseTable: "orders; drop table orders",
        tables,
        steps: [],
      }),
    ).toThrow(/table/);
  });

  it("executes all step types with exact money and unions missing columns as null", async () => {
    const available = new Map(
      [...(await listTables(ORG))].map(([name, columns]) => [name, columns.map(({ name: column, type }) => ({ name: column, type }))]),
    );
    const steps = [
      { type: "filter", column: "region", test: "contains", value: "West" },
      { type: "columns", action: "keep", columns: ["region", "amount", "q1", "q2"] },
      { type: "rename", column: "region", name: "area" },
      { type: "type", column: "amount", kind: "money" },
      { type: "split", column: "area", separator: "-", names: ["zone", "district"] },
      { type: "unpivot", columns: ["q1", "q2"], attributeName: "period", valueName: "value" },
      {
        type: "group",
        by: ["zone"],
        aggregates: [
          { operation: "sum", column: "value", name: "total" },
          { operation: "average", column: "value", name: "average" },
          { operation: "count", name: "rows" },
          { operation: "smallest", column: "value", name: "smallest" },
          { operation: "largest", column: "value", name: "largest" },
        ],
      },
      {
        type: "calculated",
        name: "adjusted",
        expression: { type: "arithmetic", left: { type: "column", name: "total" }, operator: "/", right: { type: "number", value: "2" } },
      },
      {
        type: "calculated",
        name: "caption",
        expression: { type: "text", parts: [{ type: "column", name: "zone" }, { type: "text", value: " area" }] },
      },
      {
        type: "merge",
        table: "lookup",
        join: "left",
        matches: [{ column: "zone", withColumn: "code" }],
        columns: [{ column: "label", name: "zone_label" }],
      },
      { type: "append", table: "lookup" },
    ];
    const built = buildShapeQuery({ baseTable: "orders", tables: available, steps });
    const replaced = await replaceTableFromSelect(ORG, "shaped_orders", built.sql, built.params);
    expect(replaced.rows).toBe(3);
    expect(built.sql).toContain("DECIMAL(38,6)");
    expect(
      await runBuiltQuery(
        ORG,
        `select zone, total::varchar as total, average::varchar as average, rows, smallest::varchar as smallest,
                largest::varchar as largest, adjusted::varchar as adjusted, caption, zone_label
           from shaped_orders where zone is not null`,
        [],
      ),
    ).toEqual([
      {
        zone: "West",
        total: "0.80",
        average: "0.200000",
        rows: "4",
        smallest: "0.10",
        largest: "0.30",
        adjusted: "0.400000",
        caption: "West area",
        zone_label: "Western",
      },
    ]);
    expect(await runBuiltQuery(ORG, "select total::varchar as total from shaped_orders where zone = $1", ["West"])).toEqual([{ total: "0.80" }]);
  });

  it("keeps yesterday's shaped output when a cast fails during staging", async () => {
    await expect(
      replaceTableFromSelect(ORG, "shaped_orders", "select cast('not money' as DECIMAL(18,2)) as amount", []),
    ).rejects.toThrow(/not money/);
    expect(await runBuiltQuery(ORG, "select total::varchar as total from shaped_orders where zone = $1", ["West"])).toEqual([{ total: "0.80" }]);
    expect(await runBuiltQuery(ORG, "select table_name from information_schema.tables where starts_with(table_name, '_tohyee_shape_')", [])).toEqual([]);
  });

  it("binds injection-shaped filter text as a value", async () => {
    const available = new Map(
      [...(await listTables(ORG))].map(([name, columns]) => [name, columns.map(({ name: column, type }) => ({ name: column, type }))]),
    );
    const attack = "West' OR 1=1 --";
    const built = buildShapeQuery({
      baseTable: "orders",
      tables: available,
      steps: [{ type: "filter", column: "region", test: "is", value: attack }],
    });
    expect(built.sql).not.toContain(attack);
    expect(built.params).toContain(attack);
    expect(await runBuiltQuery(ORG, built.sql, built.params)).toEqual([]);
    expect(await runBuiltQuery(ORG, "select count(*)::varchar as n from orders", [])).toEqual([{ n: "3" }]);
  });
});
