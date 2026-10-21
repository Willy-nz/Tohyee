import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTile } from "@/lib/analytics/dashboards";
import { closeAnalytics, loadCsv } from "@/lib/analytics/engine";
import type { TileQuery } from "@/lib/analytics/query";
import {
  dateHierarchy,
  drillDown,
  drillUp,
  drillView,
  expandAll,
  interactionMode,
  parseDrill,
  parseTileView,
  periodEnd,
  periodLabel,
  periodStart,
  TOP,
  viewQuery,
} from "@/lib/analytics/report-view";

const base = (groupBy: TileQuery["groupBy"]): TileQuery => ({
  table: "sales",
  groupBy,
  measures: [{ label: "Sales", aggregate: "sum", field: "amount" }],
  filters: [],
  dateField: "sold_on",
  sort: { by: "category", direction: "asc" },
  limit: null,
});

describe("drill-down and periods (#376 phase 3, decision 755)", () => {
  it("names and bounds periods, financial years by the balance date", () => {
    // A 31 May balance date (Kōwhai Dairies'): the year to 31 May 2027 is FY2027 and starts on 1 June 2026.
    expect(periodStart("2026-07-15", "fyear", 5)).toBe("2026-06-01");
    expect(periodStart("2026-05-31", "fyear", 5)).toBe("2025-06-01");
    expect(periodStart("2026-07-15", "fquarter", 5)).toBe("2026-06-01");
    expect(periodStart("2026-09-01", "fquarter", 5)).toBe("2026-09-01");
    expect(periodStart("2027-02-28", "fquarter", 5)).toBe("2026-12-01");
    expect(periodLabel("2026-06-01", "fyear", 5)).toBe("FY2027");
    expect(periodLabel("2026-12-01", "fquarter", 5)).toBe("FY2027 Q3");
    // A 31 March balance date: April starts the year, and calendar years and quarters as usual.
    expect(periodLabel("2026-04-01", "fyear", 3)).toBe("FY2027");
    expect(periodLabel("2026-04-01", "fquarter", 3)).toBe("FY2027 Q1");
    expect(periodLabel("2026-07-01", "quarter", 3)).toBe("Q3 2026");
    expect(periodLabel("2026-01-01", "year", 3)).toBe("2026");
    expect(periodLabel("2026-06-01", "month", 3)).toBe("Jun 2026");
    // A 31 December balance date is the calendar year.
    expect(periodStart("2026-07-15", "fyear", 12)).toBe("2026-01-01");
    expect(periodLabel("2026-01-01", "fyear", 12)).toBe("FY2026");
    // Leap days and month ends.
    expect(periodEnd("2024-02-29", "day")).toBe("2024-03-01");
    expect(periodEnd("2026-12-01", "fquarter")).toBe("2027-03-01");
    expect(periodStart("2026-10-22", "week", 3)).toBe("2026-10-19");
  });

  it("checks a tile's hierarchy", () => {
    const isDate = (field: string) => (field === "sold_on" ? true : ["region", "product", "amount"].includes(field) ? false : undefined);
    const groupBy = { field: "sold_on", grain: "fyear" as const };
    expect(parseDrill({ levels: dateHierarchy("sold_on", true) }, groupBy, isDate, "Sales")?.levels.map((level) => level.grain)).toEqual(["fyear", "fquarter", "month", "day"]);
    expect(parseDrill({ levels: [{ field: "region" }, { field: "product" }] }, { field: "region" }, isDate, "Sales")).toEqual({ levels: [{ field: "region" }, { field: "product" }] });
    expect(() => parseDrill({ levels: [{ field: "region" }] }, { field: "region" }, isDate, "Sales")).toThrow("2 to 4 levels");
    expect(() => parseDrill({ levels: [{ field: "product" }, { field: "region" }] }, { field: "region" }, isDate, "Sales")).toThrow("first drill-down level");
    expect(() => parseDrill({ levels: [{ field: "region" }, { field: "secret" }] }, { field: "region" }, isDate, "Sales")).toThrow("column of the chart's table");
    expect(() => parseDrill({ levels: [{ field: "region" }, { field: "region" }] }, { field: "region" }, isDate, "Sales")).toThrow("different");
    expect(() => parseDrill({ levels: [{ field: "sold_on", grain: "fyear" }, { field: "sold_on" }] }, groupBy, isDate, "Sales")).toThrow("groups its dates");
  });

  it("moves down, up and expands all", () => {
    const down = drillDown(TOP, "2026-06-01", 4);
    expect(down).toEqual({ level: 1, path: ["2026-06-01"] });
    expect(drillDown(down, "2026-09-01", 4)).toEqual({ level: 2, path: ["2026-06-01", "2026-09-01"] });
    expect(drillUp(down)).toEqual(TOP);
    expect(expandAll(TOP, 4)).toEqual({ level: 1, path: [], all: true });
    expect(drillDown({ level: 3, path: ["a", "b", "c"] }, "d", 4)).toEqual({ level: 3, path: ["a", "b", "c"] });
  });

  it("filters to the group chosen above, by period for dates", () => {
    const query = base({ field: "sold_on", grain: "fyear" });
    const drill = { levels: dateHierarchy("sold_on", true) };
    expect(drillView(query, drill, { level: 1, path: ["2026-06-01"] }, "Sales")).toEqual({
      groupBy: { field: "sold_on", grain: "fquarter" },
      filters: [
        { field: "sold_on", op: "gte", value: "2026-06-01" },
        { field: "sold_on", op: "lt", value: "2027-06-01" },
      ],
    });
    // Expanded: the next level for every year, with nothing filtered.
    expect(drillView(query, drill, { level: 1, path: [], all: true }, "Sales").filters).toEqual([]);
    expect(() => drillView(query, drill, { level: 2, path: ["2026-06-01"] }, "Sales")).toThrow("choose a group");
    expect(() => drillView(query, drill, { level: 4, path: ["a", "b", "c", "d"] }, "Sales")).toThrow("can't drill down that far");
    // A tile without a hierarchy can't be drilled.
    expect(() => drillView(base({ field: "region" }), undefined, { level: 1, path: ["Otago"] }, "Sales")).toThrow("can't drill down that far");
    // A blank group.
    expect(drillView(base({ field: "region" }), { levels: [{ field: "region" }, { field: "product" }] }, { level: 1, path: [null] }, "Sales").filters).toEqual([{ field: "region", op: "blank", value: "" }]);
  });
});

describe("clicks and drill-through stay inside the report (#376 phase 3, decision 756)", () => {
  const tiles = [
    { id: "regions", title: "By region", query: base({ field: "region" }), drill: { levels: [{ field: "region" }, { field: "product" }] }, interactions: { totals: "none" as const } },
    { id: "totals", title: "Total", query: base(null) },
    { id: "months", title: "By month", query: base({ field: "sold_on", grain: "month" }) },
  ];

  it("adds a click's filter, worked out from the clicked tile as saved", () => {
    const view = parseTileView({ selections: [{ tileId: "regions", value: "Otago", drill: { level: 1, path: ["Otago"] }, field: "secret_column" }] })!;
    // The request's "field" is ignored: the field comes from the saved tile's level.
    expect(viewQuery(tiles, tiles[2], view).where).toEqual([
      { field: "region", op: "eq", value: "Otago" },
      { field: "product", op: "eq", value: "Otago" },
    ]);
    expect(interactionMode(tiles[0], "totals")).toBe("none");
    expect(interactionMode(tiles[0], "months")).toBe("filter");
  });

  it("refuses a click on a tile that isn't on the report or has no grouping", () => {
    expect(() => viewQuery(tiles, tiles[2], { selections: [{ tileId: "other-report-tile", value: "x" }] })).toThrow("isn't on this report");
    expect(() => viewQuery(tiles, tiles[2], { selections: [{ tileId: "totals", value: "x" }] })).toThrow("isn't on this report");
    // A drill state past the clicked tile's saved levels is refused too.
    expect(() => viewQuery(tiles, tiles[2], { through: [{ tileId: "regions", value: "x", drill: { level: 2, path: ["a", "b"] } }] })).toThrow("can't drill down that far");
  });

  it("only drills a tile to its own saved levels, and checks the shape of a view", () => {
    const viewed = viewQuery(tiles, tiles[0], { drill: { level: 1, path: ["Otago"] } });
    expect(viewed.query.groupBy).toEqual({ field: "product" });
    expect(viewed.where).toEqual([{ field: "region", op: "eq", value: "Otago" }]);
    expect(() => parseTileView({ selections: Array.from({ length: 9 }, () => ({ tileId: "a", value: "b" })) })).toThrow("Up to 8");
    expect(() => parseTileView({ drill: { level: 9, path: [] } })).toThrow("drill-down");
    expect(() => parseTileView({ selections: [{ tileId: "a", value: { not: "text" } }] })).toThrow("text");
    expect(parseTileView(undefined)).toBeUndefined();
  });
});

const ORG = "report-view-test";
let root: string;

describe("financial years and view filters in the query (decisions 755-756)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-view-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    const folder = path.join(root, "src");
    fs.mkdirSync(folder);
    const file = path.join(folder, "sales.csv");
    fs.writeFileSync(
      file,
      ["sold_on,region,product,amount", "2026-05-31,Otago,Milk,10.00", "2026-06-01,Otago,Milk,20.00", "2026-08-31,Canterbury,Cream,5.50", "2026-12-01,Otago,Cream,1.25", "2027-05-31,Canterbury,Milk,100.00"].join("\n") + "\n",
    );
    await loadCsv({
      organisationId: ORG,
      sourceFolder: folder,
      file,
      table: "sales",
      columns: [
        { source: "sold_on", name: "sold_on", kind: "date" },
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

  const dates = { today: "2026-10-22", yearEndMonth: 5 };

  it("groups by financial year and quarter", async () => {
    const years = await runTile(ORG, base({ field: "sold_on", grain: "fyear" }), { dates });
    expect(years.rows.map((row) => [row.category, row.m0])).toEqual([
      ["2025-06-01", "10.00"],
      ["2026-06-01", "126.75"],
    ]);
    expect(years.columns[0].grain).toBe("fyear");
    const quarters = await runTile(ORG, base({ field: "sold_on", grain: "fquarter" }), { dates });
    expect(quarters.rows.map((row) => [row.category, row.m0])).toEqual([
      ["2026-03-01", "10.00"],
      ["2026-06-01", "25.50"],
      ["2026-12-01", "1.25"],
      ["2027-03-01", "100.00"],
    ]);
  });

  it("drills into FY2027 and filters by a click, only narrowing", async () => {
    const tiles = [
      { id: "years", title: "Years", query: base({ field: "sold_on", grain: "fyear" }), drill: { levels: dateHierarchy("sold_on", true) } },
      { id: "regions", title: "Regions", query: base({ field: "region" }) },
    ];
    const drilled = viewQuery(tiles, tiles[0], { drill: { level: 1, path: ["2026-06-01"] }, selections: [{ tileId: "regions", value: "Otago" }] });
    const result = await runTile(ORG, drilled.query, { dates, view: drilled.where });
    expect(result.rows.map((row) => [row.category, row.m0])).toEqual([
      ["2026-06-01", "20.00"],
      ["2026-12-01", "1.25"],
    ]);
    // A view filter on a field the table doesn't have is left out, as slicers are.
    const other = await runTile(ORG, base({ field: "region" }), { dates, view: [{ field: "not_here", op: "eq", value: "x" }] });
    expect(other.rows).toHaveLength(2);
  });
});

describe("financial periods on charts and projections (decision 755)", () => {
  it("names chart groups by period and projects financial years from the balance date", async () => {
    const { toEChartsOption } = await import("@/lib/analytics/chart-spec");
    const { projectionPlan } = await import("@/lib/analytics/projection");
    const theme = { text: "#111111", mutedText: "#555555", grid: "#eeeeee", background: "#ffffff", palette: ["#0e7467"] };
    const option = toEChartsOption(
      { kind: "column", category: "category", series: [{ field: "m0", label: "Sales" }], valueFormat: "number", periodName: (value) => periodLabel(value, "fyear", 5) },
      [
        { category: "2025-06-01", m0: "1" },
        { category: "2026-06-01", m0: "2" },
      ],
      theme,
    ) as { xAxis?: { data?: string[] } };
    expect(option.xAxis?.data).toEqual(["FY2026", "FY2027"]);
    const plan = projectionPlan(["2024-06-01", "2025-06-01", "2026-06-01"], [true, true, true], 1, { grain: "fyear" });
    expect(plan.ok && [plan.grain, plan.future, plan.missing]).toEqual(["fyear", ["2027-06-01"], []]);
  });
});
