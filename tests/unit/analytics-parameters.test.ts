import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, listTables, loadCsv } from "@/lib/analytics/engine";
import { parseFormula } from "@/lib/analytics/formula";
import { applyChoice, choiceFormat, onStep, parameterValues, parseChoice, parseParameters, parseSwitches, tileParameters } from "@/lib/analytics/parameters";
import { parseTileQuery, type TileQuery } from "@/lib/analytics/query";

/** What-if parameters and switches (#376 phase 4, decision 773). Made-up data. */

const ORG = "parameters-test";
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-params-"));
  process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
  const folder = path.join(root, "src");
  fs.mkdirSync(folder);
  const file = path.join(folder, "sales.csv");
  fs.writeFileSync(file, ["date,region,channel,amount,cost", "2026-04-01,North,Web,100.00,60.00", "2026-04-02,South,Shop,300.00,150.00", "2026-05-01,North,Shop,50.00,20.00"].join("\n") + "\n");
  await loadCsv({
    organisationId: ORG,
    sourceFolder: folder,
    file,
    table: "sales",
    columns: [
      { source: "date", name: "sale_date", kind: "date" },
      { source: "region", name: "region", kind: "text" },
      { source: "channel", name: "channel", kind: "text" },
      { source: "amount", name: "amount", kind: "money" },
      { source: "cost", name: "cost", kind: "money" },
    ] as never,
  });
});

afterAll(async () => {
  await closeAnalytics(ORG);
  fs.rmSync(root, { recursive: true, force: true });
});

const growth = { name: "growth", label: "Growth", min: "-0.5", max: "0.5", step: "0.05", value: "0.1" };
const tile = (measures: unknown[], extra: Record<string, unknown> = {}): TileQuery =>
  ({ table: "sales", groupBy: { field: "region" }, measures, filters: [], dateField: "sale_date", sort: { by: "category", direction: "asc" }, limit: null, pivot: null, ...extra }) as TileQuery;
const sales = { label: "Sales", aggregate: "sum", field: "amount" };
const cost = { label: "Cost", aggregate: "sum", field: "cost" };

describe("PA1: a what-if parameter in a formula", () => {
  it("works the formula out with the reader's value, exactly", async () => {
    const query = tile([sales, { label: "Next year", aggregate: "formula", formula: "[Sales] * (1 + @growth)" }]);
    const values = parameterValues(parseParameters([growth]), { growth: "0.25" });
    const result = await runTile(ORG, query, { parameters: values });
    expect(result.rows.map((row) => [row.category, row.m1])).toEqual([
      ["North", "187.500000"],
      ["South", "375.000000"],
    ]);
    // Not chosen: its starting value, 10%.
    const start = await runTile(ORG, query, { parameters: parameterValues(parseParameters([growth]), {}) });
    expect(start.rows[0].m1).toBe("165.000000");
  });

  it("refuses a formula naming a parameter the report doesn't have", async () => {
    await expect(runTile(ORG, tile([sales, { label: "X", aggregate: "formula", formula: "[Sales] * @rate" }]), {})).rejects.toThrow(/uses @rate, which this report doesn't have/);
    expect(tileParameters(tile([{ label: "X", aggregate: "formula", formula: "@a + @b * @a" }]))).toEqual(["a", "b"]);
    expect(parseFormula("@Growth + 1")).toEqual({ kind: "binary", op: "+", left: { kind: "param", name: "growth" }, right: { kind: "number", value: "1" } });
  });
});

describe("PA2: the slider only takes its own steps", () => {
  it("checks a parameter's settings and a reader's value", () => {
    expect(parseParameters([growth])).toEqual([{ id: "p-growth", ...growth, max: "0.5", min: "-0.5" }]);
    expect(() => parseParameters([{ ...growth, min: "1" }])).toThrow(/smallest should be less/);
    expect(() => parseParameters([{ ...growth, step: "0" }])).toThrow(/more than 0/);
    expect(() => parseParameters([{ ...growth, value: "0.12" }])).toThrow(/one of the slider's steps/);
    expect(() => parseParameters([{ ...growth, name: "Growth rate" }])).toThrow(/small letters/);
    expect(() => parseParameters([growth, growth])).toThrow(/already a parameter/);
    expect(() => parseParameters([{ ...growth, min: "0", max: "100000", step: "1" }])).toThrow(/1,000 steps/);
    const parameters = parseParameters([growth]);
    expect(() => parameterValues(parameters, { growth: "0.6" })).toThrow(/from -0.5 to 0.5 in steps of 0.05/);
    expect(() => parameterValues(parameters, { growth: "0.07" })).toThrow(/steps of 0.05/);
    expect(() => parameterValues(parameters, { growth: "1; drop" })).toThrow(/enter a number/);
    // Other names are dropped: only the report's own parameters count.
    expect(parameterValues(parameters, { growth: "-0.5", other: "9" })).toEqual({ growth: "-0.5" });
    expect(onStep({ min: "0", max: "1", step: "0.1" }, "0.3")).toBe(true);
  });
});

describe("PA3: switching the value shown", () => {
  const switches = { values: true as const };
  it("shows only the chosen value, and a formula still has what it names", async () => {
    const query = tile([sales, cost, { label: "Margin", aggregate: "formula", formula: "([Sales] - [Cost]) / [Sales]" }]);
    const chosen = applyChoice(query, switches, { value: 2 });
    expect(chosen.measures).toHaveLength(1);
    const result = await runTile(ORG, chosen, {});
    expect(result.columns.map((column) => column.label)).toEqual(["region", "Margin"]);
    expect(result.rows.map((row) => row.m0)).toEqual(["0.466667", "0.500000"]);
    expect(() => applyChoice(query, switches, { value: 3 })).toThrow(/doesn't offer that value/);
    expect(() => applyChoice(query, undefined, { value: 1 })).toThrow(/doesn't offer that value/);
    // Until the reader chooses, the first value shows on its own.
    expect(applyChoice(query, switches, undefined).measures.map((measure) => measure.label)).toEqual(["Sales"]);
    expect(applyChoice(query, undefined, undefined)).toBe(query);
  });

  it("keeps the chosen value's format", () => {
    const format = { series: [{ colour: "red" }, { colour: "blue" }, { colour: "green" }, { colour: "grey" }] } as never;
    const measures = tile([sales, { ...cost, compare: "previous_year" }, { label: "Rows", aggregate: "count" }]).measures;
    expect(choiceFormat(format, measures, { value: 1 })).toEqual({ series: [{ colour: "blue" }, { colour: "green" }] });
    expect(choiceFormat(format, measures, { value: 2 })).toEqual({ series: [{ colour: "grey" }] });
  });
});

describe("PA4: switching the grouping", () => {
  it("groups by one of the tile's saved groupings and nothing else", async () => {
    const tables = await listTables(ORG);
    const query = parseTileQuery(tile([sales]), tables);
    const switches = parseSwitches({ groupings: [{ field: "channel" }, { field: "sale_date" }] }, query, tables.get("sales")!, { title: "T", drill: false, visual: "column" });
    expect(switches).toEqual({ groupings: [{ field: "channel" }, { field: "sale_date", grain: "month" }] });
    const byChannel = await runTile(ORG, applyChoice(query, switches, { grouping: 1 }), {});
    expect(byChannel.rows.map((row) => [row.category, row.m0])).toEqual([
      ["Shop", "350.00"],
      ["Web", "100.00"],
    ]);
    const byMonth = await runTile(ORG, applyChoice(query, switches, { grouping: 2 }), {});
    expect(byMonth.rows.map((row) => row.category)).toEqual(["2026-04-01", "2026-05-01"]);
    // By a date it reads oldest first, whatever the tile's own order.
    expect(applyChoice({ ...query, sort: { by: "value", direction: "desc" } }, switches, { grouping: 2 }).sort).toEqual({ by: "category", direction: "asc" });
    expect(applyChoice(query, switches, { grouping: 0 })).toEqual(query);
    expect(() => applyChoice(query, switches, { grouping: 3 })).toThrow(/doesn't offer that grouping/);
  });

  it("is checked when the report is saved", async () => {
    const tables = await listTables(ORG);
    const query = parseTileQuery(tile([sales]), tables);
    const columns = tables.get("sales")!;
    const check = (input: unknown, options = { title: "T", drill: false, visual: "column" }) => () => parseSwitches(input, query, columns, options);
    expect(check({ groupings: [{ field: "nope" }] })).toThrow(/no column called nope/);
    expect(check({ groupings: [{ field: "region" }] })).toThrow(/should be different/);
    expect(check({ groupings: [{ field: "channel" }] }, { title: "T", drill: true, visual: "column" })).toThrow(/drills down/);
    expect(check({ values: true })).toThrow(/two or more values/);
    expect(parseSwitches({ groupings: [] }, query, columns, { title: "T", drill: false, visual: "column" })).toBeUndefined();
  });
});

describe("PA5: a reader's choice is positions only", () => {
  it("drops anything else", () => {
    expect(parseChoice({ value: 1, grouping: 2, field: "secret" })).toEqual({ value: 1, grouping: 2 });
    expect(parseChoice({ value: "1" })).toBeUndefined();
    expect(parseChoice({ grouping: -1 })).toBeUndefined();
    expect(parseChoice(null)).toBeUndefined();
  });
});
