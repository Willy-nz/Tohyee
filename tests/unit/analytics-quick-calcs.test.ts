import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { parseTileQuery } from "@/lib/analytics/query";
import { describeQuickCalc, quickTotal, shareOf } from "@/lib/analytics/quick-calcs";
import { tableTotals } from "@/lib/analytics/conditional";

/** Quick calculations (#376 phase 4, decision 770; examples QC1-QC8). Made-up data. */

const ORG = "quick-calc-test";
let root: string;

async function load(name: string, header: string, rows: string[], columns: Array<{ source: string; name: string; kind: string }>) {
  const folder = path.join(root, "src");
  const file = path.join(folder, `${name}.csv`);
  fs.writeFileSync(file, [header, ...rows].join("\n") + "\n");
  await loadCsv({ organisationId: ORG, sourceFolder: folder, file, table: name, columns: columns as never });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-quick-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  fs.mkdirSync(path.join(root, "src"));
  // QC setup: January 400.00, February 50.00, no March, April 250.00, May 0.00, June 30.00; West has a row with no amount.
  await load(
    "sales",
    "date,region,amount,cost",
    [
      "2026-01-05,North,100.00,10.00",
      "2026-01-20,South,300.00,90.00",
      "2026-02-11,North,50.00,5.00",
      "2026-04-02,North,200.00,20.00",
      "2026-04-30,South,50.00,5.00",
      "2026-05-15,North,0.00,0.00",
      "2026-06-01,North,30.00,3.00",
      "2026-06-02,West,,",
    ],
    [
      { source: "date", name: "sale_date", kind: "date" },
      { source: "region", name: "region", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
      { source: "cost", name: "cost", kind: "money" },
    ],
  );
  // MD1's margins again, for a share of a ratio.
  await load("margins", "date,region,sales,gross_profit", ["2026-06-10,North,100.00,10.00", "2026-06-11,South,300.00,90.00"], [
    { source: "date", name: "sale_date", kind: "date" },
    { source: "region", name: "region", kind: "text" },
    { source: "sales", name: "sales", kind: "money" },
    { source: "gross_profit", name: "gross_profit", kind: "money" },
  ]);
  await load("fx", "date,currency,foreign_total", ["2026-06-01,USD,100.00", "2026-06-02,AUD,50.00"], [
    { source: "date", name: "invoice_date", kind: "date" },
    { source: "currency", name: "currency", kind: "text" },
    { source: "foreign_total", name: "foreign_total", kind: "money" },
  ]);
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const sales = { label: "Sales", aggregate: "sum", field: "amount" };
const byMonth = (quick: unknown, extra: Record<string, unknown> = {}) => ({
  table: "sales",
  groupBy: { field: "sale_date", grain: "month" },
  measures: [{ ...sales, quick }],
  filters: [],
  dateField: "sale_date",
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});
const byRegion = (quick: unknown, extra: Record<string, unknown> = {}) => ({
  table: "sales",
  groupBy: { field: "region" },
  measures: [{ ...sales, quick }],
  filters: [],
  dateField: "sale_date",
  sort: { by: "category", direction: "asc" },
  limit: null,
  ...extra,
});
const months = (rows: Array<Record<string, string | null>>) => rows.map((row) => [row.category, row.m0]);

describe("QC1: running total", () => {
  it("adds each month to the ones before, oldest first, whatever the order shown", async () => {
    const result = await runTile(ORG, byMonth("running_total"));
    expect(months(result.rows)).toEqual([
      ["2026-01-01", "400.00"],
      ["2026-02-01", "450.00"],
      ["2026-04-01", "700.00"],
      ["2026-05-01", "700.00"],
      ["2026-06-01", "730.00"],
    ]);
    expect(result.columns.find((column) => column.key === "m0")?.format).toBe("money");
    const newest = await runTile(ORG, byMonth("running_total", { sort: { by: "category", direction: "desc" } }));
    expect(months(newest.rows)[0]).toEqual(["2026-06-01", "730.00"]);
  });

  it("shows the total so far for a group with no value (a blank adds nothing)", async () => {
    const result = await runTile(ORG, byRegion({ kind: "running_total" }));
    expect(months(result.rows)).toEqual([
      ["North", "380.00"],
      ["South", "730.00"],
      ["West", "730.00"],
    ]);
  });

  it("works a formula out again from the running totals of what it names", async () => {
    const result = await runTile(ORG, {
      ...byMonth(undefined),
      measures: [{ label: "Margin", aggregate: "formula", formula: "([Sales] - [Cost]) / [Sales]", inputs: [{ name: "Sales", ...sales }, { name: "Cost", aggregate: "sum", field: "cost" }], quick: "running_total" }],
    });
    // January (400 - 100) / 400 = 75%; to February (450 - 105) / 450 = 76.6667%.
    expect(result.rows.slice(0, 2).map((row) => row.m0)).toEqual(["0.750000", "0.766667"]);
  });

  it("is refused for balances, averages and values in several currencies", () => {
    const tables = new Map([["sales", [{ name: "sale_date", type: "DATE" }, { name: "region", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }]], ["fx", [{ name: "invoice_date", type: "DATE" }, { name: "currency", type: "VARCHAR" }, { name: "foreign_total", type: "DECIMAL(18,2)" }]]]);
    expect(() => parseTileQuery(byRegion("running_total", { measures: [{ ...sales, asAt: true, quick: "running_total" }] }), tables)).toThrow(/already a total up to its date/);
    expect(() => parseTileQuery(byRegion(undefined, { measures: [{ label: "Average", aggregate: "avg", field: "amount", quick: "running_total" }] }), tables)).toThrow(/only works for a total or a count/);
    expect(() => parseTileQuery({ ...byRegion(undefined), table: "fx", groupBy: { field: "invoice_date", grain: "month" }, dateField: "invoice_date", measures: [{ label: "FX", aggregate: "sum", field: "foreign_total", quick: "running_total" }] }, tables)).toThrow(
      /more than one currency/,
    );
  });
});

describe("QC2: % of total", () => {
  it("is a share of the whole, worked out exactly", async () => {
    const result = await runTile(ORG, byMonth("percent_of_total"));
    expect(months(result.rows)).toEqual([
      ["2026-01-01", "0.547945"],
      ["2026-02-01", "0.068493"],
      ["2026-04-01", "0.342466"],
      ["2026-05-01", "0.000000"],
      ["2026-06-01", "0.041096"],
    ]);
    expect(result.columns.find((column) => column.key === "m0")?.format).toBe("percent");
  });

  it("keeps the whole with Top N, so the shares shown don't add to 100%", async () => {
    const result = await runTile(ORG, byRegion("percent_of_total", { sort: { by: "value", direction: "desc" }, limit: 1 }));
    expect(months(result.rows)).toEqual([["North", "0.520548"]]);
  });

  it("is a share of what the filters leave", async () => {
    const result = await runTile(ORG, byMonth("percent_of_total"), { values: { region: ["North"] } });
    expect(result.rows[0].m0).toBe("0.263158");
  });

  it("leaves a blank group blank, not 0%", async () => {
    const result = await runTile(ORG, byRegion("percent_of_total"));
    expect(result.rows.find((row) => row.category === "West")?.m0).toBeNull();
  });

  it("is a share of a ratio worked out again from all the rows (MD1: 10% of 25%, not of 40%)", async () => {
    const result = await runTile(ORG, {
      table: "margins",
      groupBy: { field: "region" },
      measures: [{ label: "Margin", aggregate: "formula", formula: "[Gross profit] / [Sales]", inputs: [{ name: "Gross profit", aggregate: "sum", field: "gross_profit" }, { name: "Sales", aggregate: "sum", field: "sales" }], quick: "percent_of_total" }],
      filters: [],
      dateField: null,
      sort: { by: "category", direction: "asc" },
      limit: null,
    });
    expect(months(result.rows)).toEqual([
      ["North", "0.400000"],
      ["South", "1.200000"],
    ]);
  });
});

describe("QC3: % of row and of column", () => {
  const split = (quick: string) => ({ ...byMonth(quick), breakdown: { field: "region" }, filters: [{ field: "region", op: "neq", value: "West" }] });
  it("with a second grouping, a share of its first group or its second group", async () => {
    const row = await runTile(ORG, split("percent_of_row"));
    const jan = row.rows.filter((entry) => entry.category === "2026-01-01").map((entry) => [entry.breakdown, entry.m0]);
    expect(jan).toEqual([
      ["North", "0.250000"],
      ["South", "0.750000"],
    ]);
    const column = await runTile(ORG, split("percent_of_column"));
    expect(column.rows.find((entry) => entry.category === "2026-01-01" && entry.breakdown === "North")?.m0).toBe("0.263158");
  });

  it("in a pivot, a share of the row's total, the column's total or the grand total", async () => {
    const pivot = (quick: string) => ({
      table: "sales",
      groupBy: null,
      pivot: { rows: [{ field: "region" }], column: { field: "sale_date", grain: "quarter" } },
      measures: [{ ...sales, quick }],
      filters: [{ field: "region", op: "neq", value: "West" }],
      dateField: "sale_date",
      sort: { by: "category", direction: "asc" },
      limit: null,
    });
    const cell = (result: Awaited<ReturnType<typeof runTile>>, region: string | null, quarter: string | null) => {
      const row = result.pivot!.rows.find((entry) => (region === null ? entry.kind === "grand_total" : entry.dimensions[0] === region && entry.kind === "detail"))!;
      const column = result.pivot!.columns.find((entry) => (quarter === null ? entry.total : entry.pivotValue === quarter))!;
      return row.cells[column.key];
    };
    // North: Q1 150.00, Q2 230.00 (380.00); South: Q1 300.00, Q2 50.00 (350.00); Q1 450.00, Q2 280.00; all 730.00.
    const ofRow = await runTile(ORG, pivot("percent_of_row"));
    expect(cell(ofRow, "North", "2026-01-01")).toBe("0.394737");
    expect(cell(ofRow, "North", null)).toBe("1.000000");
    const ofColumn = await runTile(ORG, pivot("percent_of_column"));
    expect(cell(ofColumn, "North", "2026-01-01")).toBe("0.333333");
    expect(cell(ofColumn, null, "2026-01-01")).toBe("1.000000");
    const ofTotal = await runTile(ORG, pivot("percent_of_total"));
    expect(cell(ofTotal, "South", "2026-01-01")).toBe("0.410959");
    expect(cell(ofTotal, null, null)).toBe("1.000000");
    expect(ofTotal.pivot!.columns[0].measure.format).toBe("percent");
  });

  it("is refused with one grouping", () => {
    const tables = new Map([["sales", [{ name: "sale_date", type: "DATE" }, { name: "region", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }]]]);
    expect(() => parseTileQuery(byRegion("percent_of_row"), tables)).toThrow(/need a second grouping or a pivot table/);
  });
});

describe("QC4: rank", () => {
  it("ranks every group largest first, before Top N; a blank isn't ranked", async () => {
    const result = await runTile(ORG, byMonth("rank"));
    expect(months(result.rows)).toEqual([
      ["2026-01-01", "1"],
      ["2026-02-01", "3"],
      ["2026-04-01", "2"],
      ["2026-05-01", "5"],
      ["2026-06-01", "4"],
    ]);
    const regions = await runTile(ORG, byRegion({ kind: "rank", smallestFirst: true }));
    expect(months(regions.rows)).toEqual([
      ["North", "2"],
      ["South", "1"],
      ["West", null],
    ]);
    expect(regions.columns.find((column) => column.key === "m0")?.format).toBe("integer");
  });

  it("gives equal values the same place and skips the next", async () => {
    const result = await runTile(ORG, {
      ...byRegion({ kind: "rank" }),
      groupBy: { field: "sale_date", grain: "month" },
      filters: [{ field: "sale_date", op: "between", value: ["2026-04-01", "2026-06-30"] }],
      measures: [{ label: "Rows", aggregate: "count", quick: "rank" }],
    });
    // April 2 rows, May 1, June 2.
    expect(months(result.rows)).toEqual([
      ["2026-04-01", "1"],
      ["2026-05-01", "3"],
      ["2026-06-01", "1"],
    ]);
  });
});

describe("QC5: difference and % change from the previous period", () => {
  it("compares with the calendar period before; a missing month is blank, not 0", async () => {
    const difference = await runTile(ORG, byMonth("difference"));
    expect(months(difference.rows)).toEqual([
      ["2026-01-01", null],
      ["2026-02-01", "-350.00"],
      ["2026-04-01", null],
      ["2026-05-01", "-250.00"],
      ["2026-06-01", "30.00"],
    ]);
    const change = await runTile(ORG, byMonth("percent_change"));
    expect(months(change.rows)).toEqual([
      ["2026-01-01", null],
      ["2026-02-01", "-0.875000"],
      ["2026-04-01", null],
      ["2026-05-01", "-1.000000"],
      // May was 0.00: no % change from nothing.
      ["2026-06-01", null],
    ]);
  });

  it("goes by the financial quarter before for financial quarters", async () => {
    const result = await runTile(ORG, byMonth("difference", { groupBy: { field: "sale_date", grain: "fquarter" } }), { dates: { today: "2026-10-22", yearEndMonth: 3 } });
    // Financial quarters from 1 Jan (Q4 of FY2026: 450.00) and 1 Apr (Q1 of FY2027: 280.00).
    expect(months(result.rows)).toEqual([
      ["2026-01-01", null],
      ["2026-04-01", "-170.00"],
    ]);
  });

  it("goes by the group before in A to Z order for other groupings", async () => {
    const result = await runTile(ORG, byRegion("difference", { sort: { by: "value", direction: "desc" } }));
    expect(Object.fromEntries(months(result.rows))).toEqual({ North: null, South: "-30.00", West: null });
  });
});

describe("QC6: moving average", () => {
  it("averages the calendar periods in the window that have a value", async () => {
    const result = await runTile(ORG, byMonth({ kind: "moving_average", periods: 3 }));
    expect(months(result.rows)).toEqual([
      ["2026-01-01", "400.000000"],
      ["2026-02-01", "225.000000"],
      // February 50 and April 250 (March has no rows, so it isn't counted as 0).
      ["2026-04-01", "150.000000"],
      ["2026-05-01", "125.000000"],
      ["2026-06-01", "93.333333"],
    ]);
  });

  it("is refused for ratios and for fewer than 2 or more than 12 periods", () => {
    const tables = new Map([["sales", [{ name: "sale_date", type: "DATE" }, { name: "region", type: "VARCHAR" }, { name: "amount", type: "DECIMAL(18,2)" }]]]);
    expect(() => parseTileQuery(byMonth({ kind: "moving_average", periods: 13 }), tables)).toThrow(/2 to 12 periods/);
    expect(() =>
      parseTileQuery(byMonth(undefined, { measures: [{ label: "Ratio", aggregate: "formula", formula: "[A] / [A]", inputs: [{ name: "A", aggregate: "sum", field: "amount" }], quick: "moving_average" }] }), tables),
    ).toThrow(/not for averages or ratios/);
  });
});

describe("QC7: totals", () => {
  it("a share totals 100%, a running total its value's total, the others nothing", async () => {
    const shares = await runTile(ORG, byRegion("percent_of_total", { filters: [{ field: "region", op: "neq", value: "West" }] }), {}, { totals: true });
    expect(shares.totals?.m0).toBe("1.000000");
    const running = await runTile(ORG, byRegion("running_total"), {}, { totals: true });
    expect(running.totals?.m0).toBe("730.00");
    const rank = await runTile(ORG, byRegion("rank"), {}, { totals: true });
    expect(rank.totals?.m0).toBeNull();
    expect(quickTotal({ kind: "percent_of_total" }, "0.00")).toBeNull();
  });

  it("with Top N, the rows shown aren't added up", async () => {
    const result = await runTile(ORG, byRegion("running_total", { limit: 2 }), {}, { totals: true });
    expect(result.totals).toBeUndefined();
    expect(tableTotals(result.columns, result.rows, ["quick"])).toEqual({ category: null, m0: null });
  });
});

describe("QC8: what it says", () => {
  it("states the denominator and the run", () => {
    expect(describeQuickCalc({ kind: "percent_of_total" }, { dated: true, breakdown: false, pivot: false })).toMatch(/before Top N/);
    expect(describeQuickCalc({ kind: "difference" }, { dated: true, breakdown: false, pivot: false })).toMatch(/missing period is blank, not 0/);
    expect(describeQuickCalc({ kind: "moving_average", periods: 3 }, { dated: true, breakdown: false, pivot: false })).toMatch(/the 2 before it/);
    expect(shareOf("1", "3")).toBe("0.333333");
    expect(shareOf("1", "0")).toBeNull();
  });

  it("is checked: unknown kinds are refused and none is left out", async () => {
    const tables = await listTables(ORG);
    expect(() => parseTileQuery(byMonth("median"), tables)).toThrow(/choose a quick calculation/);
    expect(parseTileQuery(byMonth("none"), tables).measures[0].quick).toBeUndefined();
    expect(() => parseTileQuery({ ...byMonth("rank"), groupBy: null }, tables)).toThrow(/needs the tile grouped/);
    expect(() => parseTileQuery(byMonth("rank", { measures: [{ ...sales, compare: "previous_year", quick: "rank" }] }), tables)).toThrow(/not both/);
  });
});

describe("QC8: how a share is shown", () => {
  it("shows a fraction as a percentage to one place, exactly", async () => {
    const { showValue } = await import("@/lib/analytics/display");
    expect(showValue("0.547945", { format: "percent" })).toBe("54.8%");
    expect(showValue("-0.875000", { format: "percent" })).toBe("-87.5%");
    expect(showValue("1.000000", { format: "percent" })).toBe("100%");
    const { tileChartSpec } = await import("@/lib/analytics/tile-chart");
    const spec = tileChartSpec({ visual: "column" }, [{ key: "m0", label: "Sales (% of total)", format: "percent", role: "measure" }]);
    expect(spec?.series[0].percent).toBe(true);
  });
});
