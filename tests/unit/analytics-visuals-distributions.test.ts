import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { boxGroups, boxStats, bubbleSizes, fitLine, histogramBins, niceWidth, quantile } from "@/lib/analytics/chart-distributions";
import { tileChartSpec } from "@/lib/analytics/tile-chart";
import { dec, toPlainString } from "@/lib/money/decimal";

const theme: ChartTheme = { text: "#1b2533", mutedText: "#546072", grid: "#e9edf2", background: "#ffffff", palette: ["#1f5fae", "#d66919", "#009e98"] };

type AnyOption = Record<string, unknown> & { series: Array<Record<string, unknown>> };
function option(spec: ChartSpec, rows: Array<Record<string, string | number | null>>): AnyOption {
  const result = toEChartsOption(spec, rows, theme);
  expect("series" in result).toBe(true);
  return result as unknown as AnyOption;
}

describe("histogram bins", () => {
  it("rounds widths to 1, 2, 2.5 or 5 times a power of ten, exactly", () => {
    expect(niceWidth(7)).toBe("10");
    expect(niceWidth(180)).toBe("200");
    expect(niceWidth(23)).toBe("25");
    expect(niceWidth(0.03)).toBe("0.05");
    expect(niceWidth(0.0021)).toBe("0.0025");
    expect(niceWidth(0)).toBe("1");
  });

  it("starts at a whole number of widths and puts a value on an edge in the bin it starts", () => {
    // 8 values: Sturges gives 4 bins; the span 0.1 to 0.4 makes a width of 0.1.
    const { bins } = histogramBins(["0.1", "0.2", "0.3", "0.3", "0.35", "0.4", "0.15", "0.25"]);
    expect(bins).toEqual([
      { from: "0.1", to: "0.2", count: 2 },
      { from: "0.2", to: "0.3", count: 2 },
      // 0.3 is exactly an edge: it belongs to the bin starting at 0.3 (no 0.30000000000000004).
      { from: "0.3", to: "0.4", count: 3 },
      { from: "0.4", to: "0.5", count: 1 },
    ]);
  });

  it("handles values below zero, a chosen width or count, and leaves out blanks", () => {
    const below = histogramBins(["-15", "-5", "5", null, "x"], { width: "10" });
    expect(below.skipped).toBe(2);
    expect(below.bins).toEqual([
      { from: "-20", to: "-10", count: 1 },
      { from: "-10", to: "0", count: 1 },
      { from: "0", to: "10", count: 1 },
    ]);
    const counted = histogramBins(["0", "1000"], { bins: 4 });
    expect(counted.bins.map((bin) => bin.from)).toEqual(["0", "250", "500", "750", "1000"]);
    // A width far too small for the values falls back to an automatic one.
    expect(histogramBins(["0", "1000000"], { width: "0.01" }).bins.length).toBeLessThanOrEqual(100);
    expect(histogramBins([]).bins).toEqual([]);
  });

  it("draws touching columns named by their ranges", () => {
    const spec: ChartSpec = { kind: "histogram", category: "category", series: [{ field: "m0", label: "Invoice total", kind: "money" }], valueFormat: "money", currency: "NZD" };
    const result = option(spec, [
      { category: "INV-1", m0: "120.00" },
      { category: "INV-2", m0: "180.00" },
      { category: "INV-3", m0: "450.00" },
    ]);
    const series = result.series[0] as { barCategoryGap: string; data: number[] };
    expect(series.barCategoryGap).toBe("0%");
    expect(series.data.reduce((total, count) => total + count, 0)).toBe(3);
    expect((result.xAxis as { data: string[] }).data[0]).toBe("$0–$200");
  });
});

describe("box plot", () => {
  it("works quartiles out as QUARTILE.INC does, exactly", () => {
    const sorted = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map(dec);
    expect(toPlainString(quantile(sorted, "0.25"))).toBe("3.25");
    expect(toPlainString(quantile(sorted, "0.5"))).toBe("5.5");
    expect(toPlainString(quantile(sorted, "0.75"))).toBe("7.75");
    expect(boxStats(["0.1", "0.2", "0.3", "0.4", "0.5"])).toMatchObject({ q1: "0.2", median: "0.3", q3: "0.4", low: "0.1", high: "0.5", outliers: [] });
  });

  it("ends the whiskers at the furthest values within 1.5 box heights and keeps the rest as outliers", () => {
    expect(boxStats(["4", "1", "3", "2", "100", null])).toEqual({
      count: 5,
      min: "1",
      q1: "2",
      median: "3",
      q3: "4",
      max: "100",
      low: "1",
      high: "4",
      outliers: ["100"],
    });
    expect(boxStats([null, "n/a"])).toBeNull();
  });

  it("makes one box per group from its items, in the groups' order", () => {
    const rows = [
      { category: "North", breakdown: "a", m0: "1" },
      { category: "North", breakdown: "b", m0: "3" },
      { category: "South", breakdown: "a", m0: "10" },
      { category: "South", breakdown: "c", m0: "20" },
      { category: "South", breakdown: "d", m0: "30" },
    ];
    const boxes = boxGroups(rows, "category", "m0");
    expect(boxes.map((box) => [box.name, box.first, box.stats.median])).toEqual([["North", 0, "2"], ["South", 2, "20"]]);
    const spec = tileChartSpec({ visual: "boxplot", query: { breakdown: { field: "customer" } } }, [{ key: "m0", label: "Sales", format: "number", role: "measure" }])!;
    expect(spec.detail).toBe("breakdown");
    const result = option(spec, rows);
    expect((result.xAxis as { data: string[] }).data).toEqual(["North", "South"]);
    expect((result.series[0] as { data: number[][] }).data).toEqual([[1, 1.5, 2, 2.5, 3], [10, 15, 20, 25, 30]]);
  });

  it("without a second grouping, makes one box of every group's value", () => {
    const spec: ChartSpec = { kind: "boxplot", category: "category", series: [{ field: "m0", label: "Sales" }], valueFormat: "number", format: { boxplot: { outliers: false } } };
    const result = option(spec, [{ category: "A", m0: "1" }, { category: "B", m0: "2" }, { category: "C", m0: "90" }]);
    expect((result.xAxis as { data: string[] }).data).toEqual(["Sales"]);
    expect(result.series).toHaveLength(1);
  });
});

describe("scatter and bubble", () => {
  it("plots each group across by its first value and up by its second, sized by a third", () => {
    expect(bubbleSizes([0, 25, 100, null])).toEqual([8, 24, 40, 8]);
    const spec: ChartSpec = {
      kind: "scatter",
      category: "category",
      series: [{ field: "m0", label: "Visits" }, { field: "m1", label: "Sales" }, { field: "m2", label: "Margin" }],
      valueFormat: "number",
      format: { scatter: { trend: true } },
    };
    const result = option(spec, [
      { category: "Alpha", m0: "1", m1: "2", m2: "100" },
      { category: "Beta", m0: "2", m1: "4", m2: "25" },
      { category: "Gamma", m0: "3", m1: null, m2: "5" },
    ]);
    const points = result.series[0] as { data: Array<{ value: number[]; name: string; symbolSize: number }> };
    expect(points.data.map((point) => [point.name, point.value, point.symbolSize])).toEqual([
      ["Alpha", [1, 2], 40],
      ["Beta", [2, 4], 24],
    ]);
    expect(result.series[1]).toMatchObject({ type: "line", data: [[1, 2], [2, 4]] });
  });

  it("fits a straight line, or none when every x is the same", () => {
    expect(fitLine([[0, 1], [1, 3], [2, 5]])).toEqual([[0, 1], [2, 5]]);
    expect(fitLine([[1, 1], [1, 3]])).toBeNull();
  });
});

describe("format settings", () => {
  it("keeps bins, the across axis, the trend and outliers, and refuses bad ones", () => {
    expect(parseChartFormat({ histogram: { bins: "12" }, xAxis: { title: "Visits", min: "0" }, scatter: { trend: true }, boxplot: { outliers: false } })).toEqual({
      histogram: { bins: 12 },
      xAxis: { title: "Visits", min: "0" },
      scatter: { trend: true },
      boxplot: { outliers: false },
    });
    expect(() => parseChartFormat({ histogram: { bins: 1 } })).toThrow(/2 to 50/);
    expect(() => parseChartFormat({ histogram: { width: "-1" } })).toThrow(/more than zero/);
    expect(() => parseChartFormat({ histogram: { width: "5", bins: 4 } })).toThrow(/not both/);
  });
});
