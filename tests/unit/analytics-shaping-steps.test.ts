import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAnalytics, listTables, replaceTableFromSelect, runBuiltQuery } from "@/lib/analytics/engine";
import { buildShapeQuery, parseShapeSteps, type ShapeColumn } from "@/lib/analytics/shaping";

// #376 phase 4 "Prepare data additions" (decisions 790-798). Made-up data only.
const ORG = "shaping-steps-test";
let root: string;
let tables: Map<string, ShapeColumn[]>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-shaping-steps-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  // Loaded order matters for Fill and Index: rows 1-6 as listed.
  await replaceTableFromSelect(
    ORG,
    "sales",
    `select line::BIGINT as line, region, cast(amount as DECIMAL(18,2)) as amount, qty::BIGINT as qty, cast(sold as DATE) as sold, paid::BOOLEAN as paid, month
       from (values
         (1, 'Otago', '1234567890123456.78', 2, '2026-03-31', true, 'jan'),
         (2, null, '0.10', 3, '2026-04-01', false, 'feb'),
         (3, '', '0.20', null, '2025-12-29', true, 'jan'),
         (4, 'Canterbury', null, 5, null, null, 'feb'),
         (5, null, '100.00', 1, '2026-01-04', true, 'jan'),
         (6, 'Otago', '0.10', 3, '2026-04-01', false, 'feb')
       ) v(line, region, amount, qty, sold, paid, month)
      order by line`,
    [],
  );
  tables = new Map([...(await listTables(ORG))].map(([name, columns]) => [name, columns.map(({ name: column, type }) => ({ name: column, type }))]));
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Runs the steps on `sales` and returns every row as text (decimals stay exact), in the table's order. */
async function run(steps: unknown[], yearEndMonth?: number) {
  const built = buildShapeQuery({ baseTable: "sales", tables, steps, yearEndMonth });
  const rows = await runBuiltQuery(ORG, built.sql, built.params);
  return { rows, columns: built.columns };
}

function typeOf(columns: ShapeColumn[], name: string) {
  return columns.find((column) => column.name === name)?.type;
}

describe("Pivot column", () => {
  it("turns a column's values into columns, adding up money exactly", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["region", "amount", "month"] },
      { type: "replace", columns: ["region"], find: null, replaceWith: "None", match: "whole" },
      {
        type: "pivot",
        column: "month",
        valueColumn: "amount",
        operation: "sum",
        columns: [
          { value: "jan", name: "january" },
          { value: "feb", name: "february" },
        ],
      },
      { type: "sort", by: [{ column: "region", descending: false }] },
    ]);
    expect(columns.map((column) => column.name)).toEqual(["region", "january", "february"]);
    expect(typeOf(columns, "january")).toBe("DECIMAL(38,2)");
    expect(rows).toEqual([
      { region: "", january: "0.20", february: null },
      { region: "Canterbury", january: null, february: null },
      { region: "None", january: "100.00", february: "0.10" },
      { region: "Otago", january: "1234567890123456.78", february: "0.10" },
    ]);
  });

  it("counts, averages exactly and takes the largest; text can't be added up", async () => {
    const { rows } = await run([
      { type: "columns", action: "keep", columns: ["amount", "month"] },
      {
        type: "pivot",
        column: "month",
        valueColumn: "amount",
        operation: "average",
        columns: [{ value: "feb", name: "feb_average" }],
      },
    ]);
    expect(rows).toEqual([{ feb_average: "0.100000" }]);
    const counted = await run([
      { type: "columns", action: "keep", columns: ["month", "region"] },
      { type: "pivot", column: "month", valueColumn: "region", operation: "count", columns: [{ value: "jan", name: "jan_rows" }, { value: "mar", name: "mar_rows" }] },
    ]);
    expect(counted.rows).toEqual([{ jan_rows: "3", mar_rows: "0" }]);
    await expect(
      run([{ type: "pivot", column: "month", valueColumn: "region", operation: "sum", columns: [{ value: "jan", name: "j" }] }]),
    ).rejects.toThrow(/isn't a number/);
    expect(() => parseShapeSteps([{ type: "pivot", column: "month", valueColumn: "amount", operation: "sum", columns: [] }])).toThrow(/at least one value/);
    expect(() =>
      parseShapeSteps([{ type: "pivot", column: "month", valueColumn: "amount", operation: "sum", columns: [{ value: "a", name: "x" }, { value: "a", name: "y" }] }]),
    ).toThrow(/only once/);
  });
});

describe("Unpivot other columns", () => {
  it("unpivots every column except the ones kept, and makes mixed text and numbers text", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "amount"] },
      { type: "filter", column: "line", test: "at most", value: "2" },
      { type: "unpivot", other: true, columns: ["line"], attributeName: "field", valueName: "value" },
    ]);
    expect(typeOf(columns, "value")).toBe("VARCHAR");
    // Blank cells are dropped, as Power Query's Unpivot does.
    expect(rows).toEqual([
      { line: "1", field: "region", value: "Otago" },
      { line: "1", field: "amount", value: "1234567890123456.78" },
      { line: "2", field: "amount", value: "0.10" },
    ]);
  });
});

describe("Fill down and up", () => {
  it("fills blank cells (null or empty text) from the row above, in loaded order", async () => {
    const { rows } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "amount"] },
      { type: "fill", columns: ["region", "amount"], direction: "down" },
    ]);
    expect(rows.map((row) => [row.region, row.amount])).toEqual([
      ["Otago", "1234567890123456.78"],
      ["Otago", "0.10"],
      ["Otago", "0.20"],
      ["Canterbury", "0.20"],
      ["Canterbury", "100.00"],
      ["Otago", "0.10"],
    ]);
  });

  it("fills up from the row below, and after a Sort uses the sorted order", async () => {
    const up = await run([
      { type: "columns", action: "keep", columns: ["line", "region"] },
      { type: "fill", columns: ["region"], direction: "up" },
    ]);
    expect(up.rows.map((row) => row.region)).toEqual(["Otago", "Canterbury", "Canterbury", "Canterbury", "Otago", "Otago"]);
    const sorted = await run([
      { type: "columns", action: "keep", columns: ["line", "region"] },
      { type: "sort", by: [{ column: "line", descending: true }] },
      { type: "fill", columns: ["region"], direction: "down" },
    ]);
    expect(sorted.rows.map((row) => `${row.line}:${row.region}`)).toEqual(["6:Otago", "5:Otago", "4:Canterbury", "3:Canterbury", "2:Canterbury", "1:Otago"]);
  });

  it("needs a Sort after a step that loses the order", async () => {
    await expect(
      run([
        { type: "group", by: ["region"], aggregates: [{ operation: "count", name: "rows" }] },
        { type: "fill", columns: ["region"], direction: "down" },
      ]),
    ).rejects.toThrow("Step 2 needs the rows in order, but after step 1 (Group and summarise) they have none. Add a Sort step before step 2.");
    const fixed = await run([
      { type: "group", by: ["region"], aggregates: [{ operation: "count", name: "rows" }] },
      { type: "sort", by: [{ column: "rows", descending: true }, { column: "region", descending: false }] },
      { type: "fill", columns: ["region"], direction: "down" },
    ]);
    expect(fixed.rows).toEqual([
      { region: null, rows: "2" },
      { region: "Otago", rows: "2" },
      // The empty text region is blank, so it's filled from the row above.
      { region: "Otago", rows: "1" },
      { region: "Canterbury", rows: "1" },
    ]);
  });
});

describe("Replace values", () => {
  it("replaces whole cells, part of text, and blanks, keeping each column's type", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "amount", "paid"] },
      { type: "replace", columns: ["region"], find: "Otago", replaceWith: "Ōtākou", match: "whole" },
      { type: "replace", columns: ["region"], find: "bury", replaceWith: "-bury", match: "part" },
      { type: "replace", columns: ["amount"], find: "0.10", replaceWith: "0.15", match: "whole" },
      { type: "replace", columns: ["amount"], find: null, replaceWith: "0.00", match: "whole" },
      { type: "replace", columns: ["paid"], find: null, replaceWith: "false", match: "whole" },
    ]);
    expect(typeOf(columns, "amount")).toBe("DECIMAL(18,2)");
    expect(rows).toEqual([
      { line: "1", region: "Ōtākou", amount: "1234567890123456.78", paid: "true" },
      { line: "2", region: null, amount: "0.15", paid: "false" },
      { line: "3", region: "", amount: "0.20", paid: "true" },
      { line: "4", region: "Canter-bury", amount: "0.00", paid: "false" },
      { line: "5", region: null, amount: "100.00", paid: "true" },
      { line: "6", region: "Ōtākou", amount: "0.15", paid: "false" },
    ]);
  });

  it("refuses values that don't fit the column rather than rounding them", async () => {
    await expect(run([{ type: "replace", columns: ["amount"], find: "0.10", replaceWith: "0.105", match: "whole" }])).rejects.toThrow(
      "Replace values in amount: 0.105 has more decimal places than the column keeps (2), so it would be rounded.",
    );
    await expect(run([{ type: "replace", columns: ["amount"], find: "$1,000", replaceWith: "1", match: "whole" }])).rejects.toThrow(/isn't a number/);
    await expect(run([{ type: "replace", columns: ["sold"], find: "2026-02-30", replaceWith: "2026-03-01", match: "whole" }])).rejects.toThrow(/YYYY-MM-DD/);
    await expect(run([{ type: "replace", columns: ["amount"], find: "1", replaceWith: "2", match: "part" }])).rejects.toThrow(/only text columns/);
    expect(() => parseShapeSteps([{ type: "replace", columns: ["region"], find: "", replaceWith: "x", match: "part" }])).toThrow(/text to find/);
  });

  it("can blank out a value", async () => {
    const { rows } = await run([
      { type: "columns", action: "keep", columns: ["region"] },
      { type: "replace", columns: ["region"], find: "", replaceWith: null, match: "whole" },
      { type: "filter", column: "region", test: "is empty" },
    ]);
    expect(rows).toEqual([{ region: null }, { region: null }, { region: null }]);
  });
});

describe("Remove duplicates", () => {
  it("keeps the first row for each set of key columns, blanks counting as equal", async () => {
    const { rows } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "month"] },
      { type: "distinct", columns: ["region"] },
    ]);
    expect(rows.map((row) => row.line)).toEqual(["1", "2", "3", "4"]);
    const pairs = await run([
      { type: "columns", action: "keep", columns: ["line", "amount", "qty"] },
      { type: "distinct", columns: ["amount", "qty"] },
    ]);
    expect(pairs.rows.map((row) => row.line)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps the same row every time when the rows have no set order", async () => {
    const steps = [
      { type: "group", by: ["region", "month"], aggregates: [{ operation: "count", name: "rows" }] },
      { type: "distinct", columns: ["month"] },
      { type: "sort", by: [{ column: "month", descending: false }] },
    ];
    // Smallest region first (blanks first): the same answer however DuckDB orders the groups.
    expect((await run(steps)).rows).toEqual([
      { region: null, month: "feb", rows: "1" },
      { region: null, month: "jan", rows: "1" },
    ]);
  });
});

describe("Conditional column", () => {
  it("applies the first rule that matches, else the otherwise value", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "amount", "qty"] },
      {
        type: "conditional",
        name: "size",
        rules: [
          { column: "amount", test: "at least", value: "100", then: { type: "value", value: "Large" } },
          { column: "region", test: "is empty", then: { type: "value", value: "Unknown" } },
          { column: "amount", test: "is empty", then: { type: "blank" } },
        ],
        otherwise: { type: "column", name: "region" },
      },
    ]);
    expect(typeOf(columns, "size")).toBe("VARCHAR");
    expect(rows.map((row) => row.size)).toEqual(["Large", "Unknown", "Unknown", null, "Large", "Otago"]);
  });

  it("keeps money exact when every output is money, and checks typed values against it", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["line", "amount", "paid"] },
      {
        type: "conditional",
        name: "owing",
        rules: [{ column: "paid", test: "is", value: "true", then: { type: "value", value: "0.00" } }],
        otherwise: { type: "column", name: "amount" },
      },
    ]);
    expect(typeOf(columns, "owing")).toBe("DECIMAL(18,2)");
    // Null paid doesn't match "is true", so it falls through to otherwise.
    expect(rows.map((row) => row.owing)).toEqual(["0.00", "0.10", "0.00", null, "0.00", "0.10"]);
    await expect(
      run([
        {
          type: "conditional",
          name: "owing",
          rules: [{ column: "paid", test: "is", value: "true", then: { type: "value", value: "0.001" } }],
          otherwise: { type: "column", name: "amount" },
        },
      ]),
    ).rejects.toThrow(/more decimal places/);
  });

  it("uses a chosen type, and refuses a column that isn't there", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["qty"] },
      {
        type: "conditional",
        name: "band",
        kind: "integer",
        rules: [{ column: "qty", test: "more than", value: "2", then: { type: "value", value: "2" } }],
        otherwise: { type: "value", value: "1" },
      },
    ]);
    expect(typeOf(columns, "band")).toBe("BIGINT");
    expect(rows.map((row) => row.band)).toEqual(["1", "2", "1", "2", "1", "2"]);
    await expect(
      run([{ type: "conditional", name: "x", rules: [{ column: "nope", test: "is empty", then: { type: "blank" } }], otherwise: { type: "blank" } }]),
    ).rejects.toThrow(/no column called nope/);
    expect(() => parseShapeSteps([{ type: "conditional", name: "x", rules: [], otherwise: { type: "blank" } }])).toThrow(/at least one rule/);
  });
});

describe("Date parts", () => {
  const parts = [
    { part: "year", name: "year" },
    { part: "quarter", name: "quarter" },
    { part: "month", name: "month_number" },
    { part: "month_name", name: "month_name" },
    { part: "week", name: "week" },
    { part: "day", name: "day" },
    { part: "day_of_week", name: "weekday" },
    { part: "day_name", name: "day_name" },
    { part: "financial_year", name: "fy" },
    { part: "financial_quarter", name: "fq" },
  ];

  it("adds each part, with the financial year from a 31 March balance date", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["sold"] },
      { type: "dateParts", column: "sold", parts },
    ]);
    expect(typeOf(columns, "fy")).toBe("BIGINT");
    expect(typeOf(columns, "month_name")).toBe("VARCHAR");
    expect(rows[0]).toEqual({ sold: "2026-03-31", year: "2026", quarter: "1", month_number: "3", month_name: "March", week: "14", day: "31", weekday: "2", day_name: "Tuesday", fy: "2026", fq: "4" });
    expect(rows[1]).toMatchObject({ sold: "2026-04-01", fy: "2027", fq: "1", weekday: "3" });
    // ISO weeks: 29 December 2025 is in week 1 of 2026; 4 January 2026 (a Sunday, day 7) too.
    expect(rows[2]).toMatchObject({ sold: "2025-12-29", week: "1", fy: "2026", fq: "3", weekday: "1" });
    expect(rows[4]).toMatchObject({ sold: "2026-01-04", week: "1", weekday: "7", day_name: "Sunday" });
    // A blank date gives blank parts.
    expect(rows[3]).toEqual(Object.fromEntries(["sold", ...parts.map((part) => part.name)].map((name) => [name, null])));
  });

  it("follows the organisation's balance date", async () => {
    const june = await run([{ type: "columns", action: "keep", columns: ["sold"] }, { type: "dateParts", column: "sold", parts: [{ part: "financial_year", name: "fy" }, { part: "financial_quarter", name: "fq" }] }], 6);
    expect(june.rows.slice(0, 3)).toEqual([
      { sold: "2026-03-31", fy: "2026", fq: "3" },
      { sold: "2026-04-01", fy: "2026", fq: "4" },
      { sold: "2025-12-29", fy: "2026", fq: "2" },
    ]);
    const december = await run([{ type: "columns", action: "keep", columns: ["sold"] }, { type: "dateParts", column: "sold", parts: [{ part: "financial_year", name: "fy" }, { part: "financial_quarter", name: "fq" }] }], 12);
    expect(december.rows[2]).toEqual({ sold: "2025-12-29", fy: "2025", fq: "4" });
  });

  it("needs a date column", async () => {
    await expect(run([{ type: "dateParts", column: "region", parts: [{ part: "year", name: "y" }] }])).rejects.toThrow("region isn't a date. Change its type to a date first.");
    expect(() => parseShapeSteps([{ type: "dateParts", column: "sold", parts: [{ part: "century", name: "c" }] }])).toThrow(/date part/);
  });
});

describe("Sort", () => {
  it("sorts by several columns, blanks first going up and last going down", async () => {
    const { rows } = await run([
      { type: "columns", action: "keep", columns: ["line", "region", "amount"] },
      { type: "sort", by: [{ column: "region", descending: false }, { column: "amount", descending: true }] },
    ]);
    expect(rows.map((row) => row.line)).toEqual(["5", "2", "3", "4", "1", "6"]);
    const down = await run([{ type: "columns", action: "keep", columns: ["line", "amount"] }, { type: "sort", by: [{ column: "amount", descending: true }] }]);
    expect(down.rows.map((row) => row.amount)).toEqual(["1234567890123456.78", "100.00", "0.20", "0.10", "0.10", null]);
  });

  it("is kept in the built table", async () => {
    const built = buildShapeQuery({ baseTable: "sales", tables, steps: [{ type: "sort", by: [{ column: "sold", descending: true }] }] });
    await replaceTableFromSelect(ORG, "sorted_sales", built.sql, built.params);
    expect((await runBuiltQuery(ORG, "select line from sorted_sales", [])).map((row) => row.line)).toEqual(["2", "6", "1", "5", "3", "4"]);
  });
});

describe("Index column", () => {
  it("numbers rows from 1 by default, or from any start and step", async () => {
    const { rows, columns } = await run([{ type: "columns", action: "keep", columns: ["line"] }, { type: "index", name: "row_number", start: 1, increment: 1 }]);
    expect(typeOf(columns, "row_number")).toBe("BIGINT");
    expect(rows.map((row) => row.row_number)).toEqual(["1", "2", "3", "4", "5", "6"]);
    const custom = await run([
      { type: "columns", action: "keep", columns: ["line"] },
      { type: "sort", by: [{ column: "line", descending: true }] },
      { type: "index", name: "n", start: 0, increment: 10 },
    ]);
    expect(custom.rows.map((row) => `${row.line}:${row.n}`)).toEqual(["6:0", "5:10", "4:20", "3:30", "2:40", "1:50"]);
    expect(parseShapeSteps([{ type: "index", name: "n" }])).toEqual([{ type: "index", name: "n", start: 1, increment: 1 }]);
    expect(() => parseShapeSteps([{ type: "index", name: "n", start: 1.5 }])).toThrow(/whole number/);
    expect(() => parseShapeSteps([{ type: "index", name: "n", increment: 0 }])).toThrow(/can't be 0/);
  });

  it("needs a Sort after a merge", async () => {
    await expect(
      run([
        { type: "append", table: "sales" },
        { type: "index", name: "n", start: 1, increment: 1 },
      ]),
    ).rejects.toThrow(/after step 1 \(Append another table\) they have none/);
  });
});

describe("Custom column (formula)", () => {
  it("works out a formula exactly from number columns, with blanks staying blank", async () => {
    const { rows, columns } = await run([
      { type: "columns", action: "keep", columns: ["amount", "qty"] },
      { type: "formula", name: "with_gst", formula: "[amount] * 1.15" },
      { type: "formula", name: "each", formula: "[amount] / [qty]" },
      { type: "formula", name: "per_zero", formula: "[amount] / ([qty] - [qty])" },
      { type: "formula", name: "net", formula: "-([amount] - [amount]) + [amount]" },
    ]);
    expect(typeOf(columns, "with_gst")).toBe("DECIMAL(38,6)");
    expect(typeOf(columns, "net")).toBe("DECIMAL(38,2)");
    expect(rows[0]).toEqual({
      amount: "1234567890123456.78",
      qty: "2",
      with_gst: "1419753073641975.297000",
      each: "617283945061728.390000",
      per_zero: null,
      net: "1234567890123456.78",
    });
    expect(rows[1]).toMatchObject({ each: "0.033333", with_gst: "0.115000" });
    // A blank qty gives a blank answer (Power Query's null), not a guess.
    expect(rows[2]).toMatchObject({ qty: null, each: null, with_gst: "0.230000" });
    expect(rows[3]).toMatchObject({ amount: null, each: null, net: null });
  });

  it("is parsed, never run as code, and only uses number columns", async () => {
    expect(() => parseShapeSteps([{ type: "formula", name: "x", formula: "[amount]; drop table sales" }])).toThrow(/can't have ";"/);
    expect(() => parseShapeSteps([{ type: "formula", name: "x", formula: "[amount] / days" }])).toThrow(/days only works/);
    await expect(run([{ type: "formula", name: "x", formula: "[region] + 1" }])).rejects.toThrow("x: [region] isn't a number. A formula works with number columns.");
    await expect(run([{ type: "formula", name: "x", formula: "[missing] + 1" }])).rejects.toThrow(/no column called \[missing\]/);
    await expect(run([{ type: "formula", name: "amount", formula: "1" }])).rejects.toThrow(/already in use/);
    const floats = new Map([["readings", [{ name: "value", type: "DOUBLE" }]]]);
    expect(() => buildShapeQuery({ baseTable: "readings", tables: floats, steps: [{ type: "formula", name: "x", formula: "[value] * 2" }] })).toThrow(/isn't a number/);
  });
});

describe("Existing shapes", () => {
  it("build the same SQL as before for the steps they already had", () => {
    // Filter rows' SQL now goes through the same test builder as Conditional column; the answer is the same.
    const built = buildShapeQuery({
      baseTable: "sales",
      tables,
      steps: [
        { type: "filter", column: "region", test: "is", value: "Otago" },
        { type: "filter", column: "region", test: "is not empty" },
        { type: "unpivot", columns: ["amount", "qty"], attributeName: "field", valueName: "value" },
      ],
    });
    expect(built.sql).toBe(
      'with shape0 as (select * from "sales"), shape1 as (select * from shape0 where "region" = cast($1 as VARCHAR)), shape2 as (select * from shape1 where ("region" is not null and cast("region" as varchar) <> \'\')), shape3 as (select * from shape2 unpivot ("value" for "field" in ("amount", "qty"))) select * from shape3',
    );
  });
});
