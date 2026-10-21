import { describe, expect, it } from "vitest";
import { painterFormat, parseChartFormat, pasteFormat } from "@/lib/analytics/chart-format";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { bulletBands, funnelShares, gaugeRange, niceCeiling, waterfallSteps } from "@/lib/analytics/chart-visuals";
import { tileChartSpec } from "@/lib/analytics/tile-chart";
import { parseBands } from "@/components/analytics/visual-settings";

const theme: ChartTheme = {
  text: "#1b2533",
  mutedText: "#546072",
  grid: "#e9edf2",
  background: "#ffffff",
  palette: ["#1f5fae", "#d66919", "#009e98"],
  muted: "#8b94a1",
};

type AnyOption = Record<string, unknown> & { series: Array<Record<string, unknown>> };

function option(spec: ChartSpec, rows: Array<Record<string, string | number | null>>): AnyOption {
  const result = toEChartsOption(spec, rows, theme);
  expect("series" in result).toBe(true);
  return result as unknown as AnyOption;
}

describe("waterfall (a P&L bridge)", () => {
  it("works out running totals exactly and ends with a total bar", () => {
    // Sales, cost of sales, overheads, other income: made-up figures.
    const steps = waterfallSteps(["120000.10", "-45000.05", "-60000.03", "0.1", "0.2"]);
    expect(steps.map((step) => [step.kind, step.start, step.end])).toEqual([
      ["increase", "0", "120000.1"],
      ["decrease", "120000.1", "75000.05"],
      ["decrease", "75000.05", "15000.02"],
      ["increase", "15000.02", "15000.12"],
      // 0.1 + 0.2 lands on exactly 15000.32, not 15000.320000000002.
      ["increase", "15000.12", "15000.32"],
      ["total", "0", "15000.32"],
    ]);
    expect(steps[steps.length - 1].value).toBe("15000.32");
  });

  it("crosses zero, treats blanks as no change and can leave the total off", () => {
    const steps = waterfallSteps(["100", null, "-250", "not a number"], { total: false });
    expect(steps.map((step) => [step.kind, step.start, step.end])).toEqual([
      ["increase", "0", "100"],
      ["increase", "100", "100"],
      ["decrease", "100", "-150"],
      ["increase", "-150", "-150"],
    ]);
  });

  it("draws a bar per group plus the total, coloured by rise, fall and total", () => {
    const spec: ChartSpec = { kind: "waterfall", category: "category", series: [{ field: "m0", label: "Amount", kind: "money" }], valueFormat: "money", currency: "NZD" };
    const result = option(spec, [
      { category: "Sales", m0: "1000.00" },
      { category: "Costs", m0: "-400.00" },
    ]);
    expect((result.xAxis as { data: string[] }).data).toEqual(["Sales", "Costs", "Total"]);
    const series = result.series[0] as { type: string; data: number[][] };
    expect(series.type).toBe("custom");
    expect(series.data).toEqual([[0, 0, 1000], [1, 1000, 600], [2, 0, 600]]);
    // The tooltip gives the change and the running total.
    const tooltip = (result.tooltip as { formatter: (params: unknown) => string }).formatter([{ dataIndex: 1 }]);
    expect(tooltip).toContain("Fall (Amount)");
    expect(tooltip).toContain("-$400.00");
    expect(tooltip).toContain("Running total");
    expect(tooltip).toContain("$600.00");
  });

  it("names the total bar as chosen, or leaves it off", () => {
    const base: ChartSpec = { kind: "waterfall", category: "category", series: [{ field: "m0", label: "Amount" }], valueFormat: "number" };
    const rows = [{ category: "A", m0: "5" }];
    expect((option({ ...base, format: { waterfall: { totalLabel: "Net profit" } } }, rows).xAxis as { data: string[] }).data).toEqual(["A", "Net profit"]);
    expect((option({ ...base, format: { waterfall: { total: false } } }, rows).xAxis as { data: string[] }).data).toEqual(["A"]);
  });
});

describe("funnel", () => {
  it("gives each stage its share of the first stage or the one before", () => {
    expect(funnelShares([200, 100, 50, null], "first")).toEqual([1, 0.5, 0.25, null]);
    expect(funnelShares([200, 100, 50], "previous")).toEqual([1, 0.5, 0.5]);
    expect(funnelShares([0, 10], "first")).toEqual([1, null]);
  });

  it("keeps the stages in the tile's order", () => {
    const spec: ChartSpec = { kind: "funnel", category: "category", series: [{ field: "m0", label: "Deals" }], valueFormat: "number" };
    const result = option(spec, [
      { category: "Lead", m0: "40" },
      { category: "Quote", m0: "60" },
      { category: "Won", m0: "10" },
    ]);
    const series = result.series[0] as { type: string; sort: string; data: Array<{ name: string; value: number }> };
    expect(series.type).toBe("funnel");
    expect(series.sort).toBe("none");
    expect(series.data.map((entry) => entry.name)).toEqual(["Lead", "Quote", "Won"]);
  });
});

describe("gauge", () => {
  it("runs from 0 to twice the value rounded up, or to the target if further, unless chosen", () => {
    expect(niceCeiling(7300)).toBe(8000);
    expect(niceCeiling(180)).toBe(200);
    expect(niceCeiling(240)).toBe(250);
    expect(niceCeiling(0.33)).toBe(0.4);
    expect(gaugeRange(3650, null, {})).toEqual({ min: 0, max: 8000 });
    // With a target: a little past it (or the value).
    expect(gaugeRange(2989465.6, 3500000, {})).toEqual({ min: 0, max: 4000000 });
    expect(gaugeRange(1000, 4500, {})).toEqual({ min: 0, max: 5000 });
    expect(gaugeRange(50, 80, { min: "10", max: "120" })).toEqual({ min: 10, max: 120 });
  });

  it("shows one total with its target from the second value, without a group column", () => {
    const spec = tileChartSpec({ visual: "gauge" }, [
      { key: "m0", label: "Sales", format: "money", role: "measure" },
      { key: "m1", label: "Budget", format: "money", role: "measure" },
    ])!;
    const result = option(spec, [{ m0: "750.00", m1: "1000.00" }]);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toMatchObject({ type: "gauge", min: 0, max: 1200 });
    const detail = (result.series[1] as { detail: { formatter: () => string } }).detail.formatter();
    expect(detail).toBe("Target $1,000.00");
  });

  it("colours the value by a colour rule", () => {
    const spec: ChartSpec = { kind: "gauge", category: "category", series: [{ field: "m0", label: "Margin" }], valueFormat: "number", format: { chartRules: [{ op: "<", value: "0.3", color: "#ba3e3c" }] } };
    const result = option(spec, [{ m0: "0.25" }]);
    expect((result.series[0] as { progress: { itemStyle: { color: string } } }).progress.itemStyle.color).toBe("#ba3e3c");
  });
});

describe("bullet chart", () => {
  it("shades bands at percentages of the target, the last to 120% of it or the value", () => {
    expect(bulletBands(100, 50)).toEqual([60, 20, 40]);
    expect(bulletBands(100, 150, [50])).toEqual([50, 100]);
    expect(bulletBands(null, 50)).toEqual([]);
  });

  it("draws bands, the value and the target for each group", () => {
    const spec: ChartSpec = {
      kind: "bullet",
      category: "category",
      series: [{ field: "m0", label: "Sales" }, { field: "m1", label: "Budget" }],
      valueFormat: "number",
    };
    const result = option(spec, [
      { category: "North", m0: "80", m1: "100" },
      { category: "South", m0: "30", m1: "50" },
    ]);
    expect(result.series.map((series) => series.type)).toEqual(["bar", "bar", "bar", "bar", "scatter"]);
    expect(result.series[3]).toMatchObject({ name: "Sales", data: [80, 30] });
    expect(result.series[4]).toMatchObject({ data: [[100, 0], [50, 1]] });
  });

  it("works without groups, with a typed target", () => {
    const spec: ChartSpec = { kind: "bullet", category: "category", series: [{ field: "m0", label: "Sales" }], valueFormat: "number", format: { bullet: { target: "200" } } };
    const result = option(spec, [{ m0: "150" }]);
    expect((result.yAxis as { data: string[] }).data).toEqual(["Sales"]);
    expect(result.series[result.series.length - 1]).toMatchObject({ type: "scatter", data: [[200, 0]] });
  });

  it("reads typed band edges", () => {
    expect(parseBands("60, 80")).toEqual([60, 80]);
    expect(parseBands("")).toBeUndefined();
    expect(parseBands("80, 60")).toBeNull();
    expect(parseBands("10 20 30 40")).toBeNull();
  });
});

describe("format settings for the new visuals", () => {
  it("keeps known settings and refuses bad ones", () => {
    expect(
      parseChartFormat({
        waterfall: { total: false, totalLabel: " Net profit ", increase: "#057836", nonsense: 1 },
        funnel: { percent: "previous" },
        gauge: { min: "0", max: "500", target: 400 },
        bullet: { bands: [50, 75, 100], target: "10" },
      }),
    ).toEqual({
      waterfall: { total: false, totalLabel: "Net profit", increase: "#057836" },
      funnel: { percent: "previous" },
      gauge: { min: "0", max: "500", target: "400" },
      bullet: { bands: [50, 75, 100], target: "10" },
    });
    expect(() => parseChartFormat({ gauge: { min: "5", max: "1" } })).toThrow(/maximum/);
    expect(() => parseChartFormat({ bullet: { bands: [80, 60] } })).toThrow(/go up/);
    expect(() => parseChartFormat({ waterfall: { decrease: "red" } })).toThrow(/colour/);
    expect(() => parseChartFormat({ funnel: { percent: "half" } })).toThrow();
  });

  it("leaves the data's numbers (gauge range, targets) out of copied formats and chart type defaults", () => {
    expect(painterFormat({ gauge: { max: "10" }, bullet: { target: "5", bands: [50] }, waterfall: { total: false } })).toEqual({ bullet: { bands: [50] }, waterfall: { total: false } });
    expect(pasteFormat({ waterfall: { total: false } }, { gauge: { max: "10" }, bullet: { target: "5" } })).toEqual({ waterfall: { total: false }, gauge: { max: "10" }, bullet: { target: "5" } });
  });
});
