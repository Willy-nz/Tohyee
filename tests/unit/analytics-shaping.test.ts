import { describe, expect, it } from "vitest";
import { buildShapeQuery } from "@/lib/analytics/shaping";

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
});
