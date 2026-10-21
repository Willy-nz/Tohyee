import { describe, expect, it } from "vitest";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { calendarHeight, calendarYears, heatCells, sankeyFlows, treeNodes } from "@/lib/analytics/chart-relationships";
import { CHART_TOKENS, chartThemeFromTokens } from "@/lib/charts/theme";

const theme: ChartTheme = chartThemeFromTokens(CHART_TOKENS.light);

type AnyOption = Record<string, unknown> & { series: Array<Record<string, unknown>> };
function option(spec: ChartSpec, rows: Array<Record<string, string | number | null>>): AnyOption {
  const result = toEChartsOption(spec, rows, theme);
  expect("series" in result).toBe(true);
  return result as unknown as AnyOption;
}

const rows = [
  { category: "North", breakdown: "Widgets", m0: "0.10" },
  { category: "North", breakdown: "Gadgets", m0: "0.20" },
  { category: "South", breakdown: "Widgets", m0: "5.00" },
  { category: "South", breakdown: "Widgets", m0: "-1.00" },
  { category: "South", breakdown: null, m0: null },
];

describe("treemap", () => {
  it("adds each group's boxes up exactly, largest first, leaving out what has no area", () => {
    const names = rows.map((row) => row.category);
    expect(treeNodes(rows, names, "m0", "breakdown")).toEqual({
      nodes: [
        { name: "South", value: "5", children: [{ name: "Widgets", value: "5" }] },
        // 0.1 + 0.2 is exactly 0.3.
        { name: "North", value: "0.3", children: [{ name: "Gadgets", value: "0.2" }, { name: "Widgets", value: "0.1" }] },
      ],
      skipped: 2,
    });
    expect(treeNodes(rows, names, "m0").nodes.map((node) => [node.name, node.value, node.children])).toEqual([["South", "5", undefined], ["North", "0.3", undefined]]);
  });

  it("colours the top groups in the theme's order", () => {
    const spec: ChartSpec = { kind: "treemap", category: "category", detail: "breakdown", series: [{ field: "m0", label: "Sales" }], valueFormat: "number" };
    const series = option(spec, rows).series[0] as { type: string; data: Array<{ name: string; itemStyle: { color: string }; children: unknown[] }> };
    expect(series.type).toBe("treemap");
    expect(series.data.map((node) => [node.name, node.itemStyle.color, node.children.length])).toEqual([["South", theme.palette[0], 1], ["North", theme.palette[1], 2]]);
  });
});

describe("heat map", () => {
  it("puts each group across and each second-grouping value down, totals added exactly", () => {
    const grid = heatCells(rows, rows.map((row) => row.category), "m0", "breakdown");
    expect(grid.across).toEqual(["North", "South"]);
    expect(grid.down).toEqual(["Widgets", "Gadgets", "(blank)"]);
    expect(grid.cells).toEqual([
      { x: 0, y: 0, value: "0.1" },
      { x: 0, y: 1, value: "0.2" },
      { x: 1, y: 0, value: "4" },
    ]);
  });

  it("uses one hue for amounts, and the diverging pair when they're both sides of zero", () => {
    const spec: ChartSpec = { kind: "heatmap", category: "category", detail: "breakdown", series: [{ field: "m0", label: "Sales" }], valueFormat: "number" };
    const positive = option(spec, rows.slice(0, 3)) as AnyOption & { visualMap: { inRange: { color: string[] }; min: number } };
    expect(positive.visualMap.inRange.color).toEqual(CHART_TOKENS.light.sequential);
    expect(positive.visualMap.min).toBe(0);
    const mixed = option(spec, [...rows.slice(0, 2), { category: "East", breakdown: "Widgets", m0: "-3" }]) as AnyOption & { visualMap: { inRange: { color: string[] }; min: number; max: number } };
    expect(mixed.visualMap.inRange.color).toEqual([CHART_TOKENS.light.diverging.below, CHART_TOKENS.light.diverging.middle, CHART_TOKENS.light.diverging.above]);
    expect([mixed.visualMap.min, mixed.visualMap.max]).toEqual([-3, 3]);
  });
});

describe("calendar heat map", () => {
  it("shows the latest three years with data, newest first, and is tall enough for them", () => {
    expect(calendarYears(["2023-05-01", "2026-01-02", "2024-12-31", "2025-07-07", "2026-03-01", "not a date"])).toEqual(["2026", "2025", "2024"]);
    expect(calendarHeight(1)).toBeLessThan(calendarHeight(3));
    const spec: ChartSpec = { kind: "calendar", category: "category", series: [{ field: "m0", label: "Milk" }], valueFormat: "number" };
    const result = option(spec, [{ category: "2026-01-02", m0: "10" }, { category: "2025-06-01", m0: "4" }]) as AnyOption & { calendar: Array<{ range: string }> };
    expect(result.calendar.map((calendar) => calendar.range)).toEqual(["2026", "2025"]);
    expect(result.series.map((series) => (series.data as unknown[]).length)).toEqual([1, 1]);
  });
});

describe("Sankey", () => {
  it("flows from each group to each second-grouping value, keeping a name on both sides apart", () => {
    const flows = sankeyFlows(
      [
        { category: "Sales", breakdown: "Bank", m0: "0.10" },
        { category: "Sales", breakdown: "Bank", m0: "0.20" },
        { category: "Bank", breakdown: "Wages", m0: "0.25" },
        { category: "Bank", breakdown: "Loss", m0: "-2" },
      ],
      ["Sales", "Sales", "Bank", "Bank"],
      "m0",
      "breakdown",
    );
    expect(flows.links).toEqual([
      { source: "Sales", target: "Bank​", value: "0.3" },
      { source: "Bank", target: "Wages", value: "0.25" },
    ]);
    expect(flows.nodes.map((node) => node.label)).toEqual(["Sales", "Bank", "Bank", "Wages"]);
    expect(flows.skipped).toBe(1);
  });

  it("draws nodes and links", () => {
    const spec: ChartSpec = { kind: "sankey", category: "category", detail: "breakdown", series: [{ field: "m0", label: "Amount" }], valueFormat: "number" };
    const series = option(spec, rows).series[0] as { type: string; links: Array<{ value: number }>; data: Array<{ name: string; total: string }> };
    expect(series.type).toBe("sankey");
    expect(series.links.map((link) => link.value)).toEqual([0.1, 0.2, 5]);
    expect(series.data.find((node) => node.name === "Widgets")?.total).toBe("5.1");
  });
});
