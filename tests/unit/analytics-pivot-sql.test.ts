import { describe, expect, it } from "vitest";
import { buildPivotSql, parseTileQuery } from "@/lib/analytics/query";

describe("analytics pivot SQL", () => {
  it("quotes checked dimensions, binds filter values and keeps averages exact", () => {
    const tables = new Map([
      [
        "sales",
        [
          { name: 'region"name', type: "VARCHAR" },
          { name: "order_date", type: "DATE" },
          { name: "amount", type: "DECIMAL(18,2)" },
        ],
      ],
    ]);
    const query = parseTileQuery(
      {
        table: "sales",
        pivot: { rows: [{ field: 'region"name' }], column: { field: "order_date", grain: "quarter" } },
        measures: [
          { label: "Sales", aggregate: "sum", field: "amount" },
          { label: "Average", aggregate: "avg", field: "amount" },
        ],
        filters: [{ field: 'region"name', op: "eq", value: "Otago' or '1'='1" }],
      },
      tables,
    );
    const built = buildPivotSql(query, tables.get("sales")!);

    expect(built.sql).toContain('"region""name"');
    expect(built.sql).toContain("grouping sets");
    expect(built.sql).toContain("grouping_id");
    expect(built.sql).toContain("HUGEINT");
    expect(built.sql).not.toContain("Otago");
    expect(built.params).toEqual(["Otago' or '1'='1"]);
    expect(built.rowFields.map((field) => field.label)).toEqual(['region"name']);
  });

  it("rejects duplicate dimensions, invalid row counts and distinct-count measures", () => {
    const tables = new Map([["sales", [{ name: "region", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }]]]);
    const parse = (pivot: unknown, measures = [{ label: "Sales", aggregate: "sum", field: "amount" }]) =>
      parseTileQuery({ table: "sales", pivot, measures }, tables);

    expect(() => parse({ rows: [], column: null })).toThrow(/between 1 and 5 row fields/);
    expect(() => parse({ rows: [{ field: "region" }, { field: "region" }], column: null })).toThrow(/only be used once/);
    expect(() => parse({ rows: [{ field: "region" }], column: null }, [{ label: "Regions", aggregate: "count_distinct", field: "region" }])).toThrow(
      /pivot values can be summed/,
    );
  });
});
