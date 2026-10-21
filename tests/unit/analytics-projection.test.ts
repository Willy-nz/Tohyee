import { describe, expect, it } from "vitest";
import { chartRows, projectedRows, toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { addPeriods, projectionNote, projectionPlan } from "@/lib/analytics/projection";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { tileChartSpec } from "@/lib/analytics/tile-chart";

/** Linear projection (#387, decision 692): only on a regular run of dates, oldest first, with gaps never read as zero. */

const theme: ChartTheme = {
  text: "#1b2533",
  mutedText: "#546072",
  grid: "#e9edf2",
  axis: "#c5cdd8",
  background: "#ffffff",
  palette: ["#1f5fae", "#d66919", "#009e98", "#e2a520"],
  negative: "#d03b3b",
};

type Row = Record<string, string | null>;
type AnyOption = {
  series: Array<Record<string, unknown> & { name?: string; data: unknown[] }>;
  xAxis?: { data: string[] };
  tooltip?: { formatter?: (params: unknown) => string };
};

const spec = (projection: ChartSpec["projection"], forecast = 2): ChartSpec => ({
  kind: "line",
  category: "category",
  series: [{ field: "m0", label: "Sales", kind: "money" }],
  valueFormat: "money",
  format: { series: [{ forecast }] },
  ...(projection ? { projection } : {}),
});
const draw = (chart: ChartSpec, rows: Row[]) => toEChartsOption(chart, rows, theme) as unknown as AnyOption;
const projectionOf = (result: AnyOption) => result.series.find((series) => series.name === "Sales linear projection");
const monthly = { grain: "month" as const, sort: { by: "category" as const, direction: "asc" as const }, limit: null, truncated: false };

const rows = (pairs: Array<[string, string | null]>): Row[] => pairs.map(([category, m0]) => ({ category, m0 }));

describe("the periods a projection runs on", () => {
  it("steps by the grain, including month ends and leap years", () => {
    expect(addPeriods("2026-01-01", "month", 1)).toBe("2026-02-01");
    expect(addPeriods("2026-11-01", "quarter", 1)).toBe("2027-02-01");
    expect(addPeriods("2024-02-26", "week", 1)).toBe("2024-03-04");
    expect(addPeriods("2024-02-28", "day", 1)).toBe("2024-02-29");
    expect(addPeriods("2026-01-01", "year", 2)).toBe("2028-01-01");
  });
});

describe("projecting a regular monthly series", () => {
  it("draws the next months after the last, shaded and labelled as projected", () => {
    const result = draw(spec(monthly), rows([["2026-01-01", "100"], ["2026-02-01", "200"], ["2026-03-01", "300"]]));
    expect(result.xAxis!.data).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026"]);
    const projection = projectionOf(result)!;
    expect(projection.data).toEqual([null, null, 300, 400, 500]);
    expect(projection.lineStyle).toMatchObject({ type: "dotted" });
    expect(projection.markArea).toMatchObject({ label: { formatter: "Projected" }, data: [[{ xAxis: "Apr 2026" }, { xAxis: "May 2026" }]] });
    // The tooltip of a projected month says so, in the heading and on the figure.
    const html = result.tooltip!.formatter!([
      { seriesIndex: 0, dataIndex: 3, seriesName: "Sales", axisValueLabel: "Apr 2026", value: null },
      { seriesIndex: 1, dataIndex: 3, seriesName: "Sales trend", axisValueLabel: "Apr 2026", value: null },
      { seriesIndex: 2, dataIndex: 3, seriesName: "Sales linear projection", axisValueLabel: "Apr 2026", value: 400 },
    ]);
    expect(html).toContain("Apr 2026 (projected)");
    expect(html).toContain("projected, not an actual");
    expect(html).toContain("$400.00");
    // An actual month doesn't.
    const actual = result.tooltip!.formatter!([{ seriesIndex: 0, dataIndex: 1, seriesName: "Sales", axisValueLabel: "Feb 2026", value: 200 }]);
    expect(actual).not.toContain("projected");
    // And the chart's table (screen readers) lists the projected months apart from the data.
    expect(projectedRows(spec(monthly), rows([["2026-01-01", "100"], ["2026-02-01", "200"], ["2026-03-01", "300"]]))).toEqual([
      { period: "2026-04-01", values: [400] },
      { period: "2026-05-01", values: [500] },
    ]);
  });

  it("explains that it isn't the cash flow forecast", () => {
    const { projection } = chartRows(spec(monthly), rows([["2026-01-01", "100"], ["2026-02-01", "200"]]));
    expect(projection!.note).toMatch(/^Linear projection: the straight-line trend of the dates shown, carried on 2 months/);
    expect(projection!.note).toMatch(/isn't a forecast of the books/);
  });
});

describe("acceptance cases (#387)", () => {
  it("a missing month is put back as a gap, not zero, and the line is fitted on the real months", () => {
    // Jan 100, Feb missing, Mar 300, Apr 400: on real positions the line is 100 a month.
    const data = rows([["2026-01-01", "100"], ["2026-03-01", "300"], ["2026-04-01", "400"]]);
    const result = draw(spec(monthly), data);
    expect(result.xAxis!.data).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026"]);
    expect(result.series[0].data.slice(0, 4)).toEqual([100, null, 300, 400]);
    expect(projectionOf(result)!.data).toEqual([null, null, null, 400, 500, 600]);
    const { projection } = chartRows(spec(monthly), data);
    expect(projection!.plan).toMatchObject({ ok: true, missing: ["2026-02-01"] });
    expect(projection!.note).toMatch(/1 month with no data is shown as a gap, not zero/);
  });

  it("irregular dates are put on the grain's own steps, so the labels don't invent a spacing", () => {
    // Days 1, 3 and 10: daily, with the missing days as gaps; the projection is the next days.
    const data = rows([["2026-03-01", "10"], ["2026-03-03", "30"], ["2026-03-10", "100"]]);
    const plan = chartRows(spec({ grain: "day" }), data).projection!.plan;
    expect(plan).toMatchObject({ ok: true, grain: "day", future: ["2026-03-11", "2026-03-12"] });
    if (plan.ok) expect(plan.periods).toHaveLength(10);
    // Without the tile's grain, the dates themselves decide: these aren't the start of months, so days.
    expect(chartRows(spec(undefined), data).projection!.plan).toMatchObject({ ok: true, grain: "day" });
    // Dates that don't start the tile's grain are refused rather than guessed.
    expect(projectionPlan(["2026-03-01", "2026-03-15"], [true, true], 2, { grain: "month" })).toEqual({ ok: false, reason: "the dates don't each start a month" });
  });

  it("descending dates are refused", () => {
    const data = rows([["2026-03-01", "300"], ["2026-02-01", "200"], ["2026-01-01", "100"]]);
    const result = draw(spec({ ...monthly, sort: { by: "category", direction: "desc" } }), data);
    expect(projectionOf(result)).toBeUndefined();
    expect(result.xAxis!.data).toHaveLength(3);
    expect(chartRows(spec({ ...monthly, sort: { by: "category", direction: "desc" } }), data).projection!.note).toBe(
      "Linear projection not shown: the dates are newest first; sort them oldest first.",
    );
    // Even without the tile's sort, dates out of order are caught.
    expect(chartRows(spec(undefined), data).projection!.plan).toEqual({ ok: false, reason: "the dates aren't in order, oldest first" });
  });

  it("Top N, value-sorted and cut-short answers are refused", () => {
    const data = rows([["2026-01-01", "100"], ["2026-02-01", "200"], ["2026-03-01", "300"]]);
    expect(chartRows(spec({ ...monthly, limit: 3 }), data).projection!.note).toBe(
      "Linear projection not shown: the tile keeps only its top 3 groups, so some periods are left out.",
    );
    expect(chartRows(spec({ ...monthly, sort: { by: "value", direction: "desc" } }), data).projection!.plan).toMatchObject({ ok: false, reason: "the groups are sorted by value, not by date" });
    expect(chartRows(spec({ ...monthly, truncated: true }), data).projection!.plan).toMatchObject({ ok: false });
    expect(projectionOf(draw(spec({ ...monthly, limit: 3 }), data))).toBeUndefined();
  });

  it("fewer than two usable periods are refused", () => {
    expect(chartRows(spec(monthly), rows([["2026-01-01", "100"]])).projection!.plan).toEqual({ ok: false, reason: "it needs at least two periods with a value" });
    expect(chartRows(spec(monthly), rows([["2026-01-01", "100"], ["2026-02-01", null]])).projection!.plan).toMatchObject({ ok: false });
    expect(projectionOf(draw(spec(monthly), rows([["2026-01-01", "100"], ["2026-02-01", null]])))).toBeUndefined();
  });

  it("groups that aren't dates, and blank dates, are refused", () => {
    const regions = rows([["Otago", "100"], ["Canterbury", "200"]]);
    expect(chartRows(spec({ grain: null }), regions).projection!.note).toMatch(/needs the chart grouped by a date/);
    expect(chartRows(spec(undefined), regions).projection!.plan).toMatchObject({ ok: false });
    expect(chartRows(spec(undefined), rows([["2026-01-01", "1"], ["", "2"]])).projection!.plan).toEqual({ ok: false, reason: "some rows have no date" });
    // A trend line on its own still works on any groups (it's by position).
    const trend = draw({ ...spec({ grain: null }), format: { series: [{ trend: true, forecast: 2 }] } }, regions);
    expect(trend.series.find((series) => series.name === "Sales trend")!.data).toEqual([100, 200]);
    expect(projectionOf(trend)).toBeUndefined();
  });
});

describe("saved settings stay compatible", () => {
  it("keeps the saved `forecast` setting as the projection length", () => {
    expect(parseChartFormat({ series: [{ forecast: 3 }] })).toEqual({ series: [{ forecast: 3 }] });
    expect(() => parseChartFormat({ series: [{ forecast: 13 }] })).toThrow(/linear projection/);
  });

  it("gets the tile's grain, sort, Top N and cut-short answer from its question", () => {
    const chart = tileChartSpec(
      { visual: "line", format: { series: [{ forecast: 2 }] } },
      [{ key: "m0", label: "Sales", role: "measure", format: "money" }],
      { query: { groupBy: { field: "invoice_date", grain: "quarter" }, sort: { by: "category", direction: "asc" }, limit: 4 }, truncated: false },
    )!;
    expect(chart.projection).toEqual({ grain: "quarter", sort: { by: "category", direction: "asc" }, limit: 4, truncated: false });
    const byRegion = tileChartSpec({ visual: "line" }, [{ key: "m0", label: "Sales", role: "measure", format: "money" }], { query: { groupBy: { field: "region" }, sort: { by: "value", direction: "desc" }, limit: null } })!;
    expect(byRegion.projection?.grain).toBeNull();
  });

  it("names the reason in plain words", () => {
    expect(projectionNote({ ok: false, reason: "it needs at least two periods with a value" }, 2)).toBe("Linear projection not shown: it needs at least two periods with a value.");
  });
});
