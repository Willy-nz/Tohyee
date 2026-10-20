import { describe, expect, it } from "vitest";
import { parseChartFormat, type ChartFormat } from "@/lib/analytics/chart-format";
import { BUILT_IN_THEMES, chosenColourWarnings } from "@/lib/charts/report-themes";
import { cardStyle, referenceValue, toEChartsOption, trendLine, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";

/** Per-visual formatting (#376 phase 1, part 2): every new setting goes through parseChartFormat. */

const theme: ChartTheme = {
  text: "#1b2533",
  mutedText: "#546072",
  grid: "#e9edf2",
  axis: "#c5cdd8",
  background: "#ffffff",
  palette: ["#1f5fae", "#d66919", "#009e98", "#e2a520", "#d4679f", "#057836", "#694daf", "#ba3e3c"],
  negative: "#d03b3b",
};

type AnyOption = Record<string, unknown> & {
  color: string[];
  series: Array<Record<string, unknown> & { data: unknown[] }>;
  xAxis?: Record<string, unknown>;
  yAxis?: Array<Record<string, unknown>> | Record<string, unknown>;
  legend?: Record<string, unknown>;
  tooltip?: Record<string, unknown>;
  grid?: Record<string, unknown>;
  title?: Record<string, unknown> | Array<Record<string, unknown>>;
};

const months = [
  { month: "2026-01-01", sales: "100", costs: "40" },
  { month: "2026-02-01", sales: "200", costs: "60" },
  { month: "2026-03-01", sales: "300", costs: "50" },
  { month: "2026-04-01", sales: "400", costs: "90" },
];
const columns: ChartSpec = {
  kind: "column",
  category: "month",
  series: [
    { field: "sales", label: "Sales", kind: "money" },
    { field: "costs", label: "Costs", kind: "money" },
  ],
  valueFormat: "money",
};
const option = (spec: ChartSpec, format: ChartFormat, rows: Record<string, string | null>[] = months) =>
  toEChartsOption({ ...spec, format }, rows, theme) as unknown as AnyOption;
const yAxis = (result: AnyOption) => (Array.isArray(result.yAxis) ? result.yAxis[0] : result.yAxis!) as Record<string, unknown>;

describe("checking the new settings", () => {
  it("keeps known settings, drops unknown ones and refuses wrong values", () => {
    const parsed = parseChartFormat({
      card: { title: { size: 18, bold: true, italic: true, color: "#AA3300", align: "center", background: "#ffeedd", extra: 1 }, fill: "#123456", opacity: 80, borderColor: "#000000", borderWidth: 2, radius: 12, shadow: "soft", padding: 20 },
      series: [{ hex: "#FF0000", lineWidth: 3, lineStyle: "dashed", step: true, markers: false, tooltip: "hide", trend: true, forecast: 3 }],
      categoryColors: [{ name: "Otago", color: "#00ff00" }],
      labels: { size: 14, color: "#333333", number: { decimals: 0 }, content: { category: true, percent: false }, density: "ends" },
      categoryAxis: { show: false, size: 11, color: "#444444", rotate: 45, interval: 2, reverse: true, from: "2026-01-01", to: "2026-06-30" },
      valueAxis: { show: true, rotate: -30, number: { compact: false }, step: "50", reverse: true, size: 10 },
      legend: { size: 13, title: "Values", position: "bottom-left" },
      gridlines: { style: "dashed", color: "#cccccc" },
      plot: { background: "#fafafa" },
      tooltip: { total: true, show: false },
      referenceLines: [{ kind: "average", series: 0, label: "Average", color: "#990000", style: "dotted", nonsense: true }, { kind: "band", value: "100", to: "200" }],
      bars: { thickness: 30, gap: 20, rounded: false },
    });
    expect(parsed).toEqual({
      card: { title: { size: 18, bold: true, italic: true, color: "#aa3300", align: "center", background: "#ffeedd" }, fill: "#123456", opacity: 80, borderColor: "#000000", borderWidth: 2, radius: 12, shadow: "soft", padding: 20 },
      series: [{ hex: "#ff0000", lineWidth: 3, lineStyle: "dashed", step: true, markers: false, tooltip: "hide", trend: true, forecast: 3 }],
      categoryColors: [{ name: "Otago", color: "#00ff00" }],
      labels: { size: 14, color: "#333333", number: { decimals: 0 }, content: { category: true, percent: false }, density: "ends" },
      categoryAxis: { show: false, size: 11, color: "#444444", rotate: 45, interval: 2, reverse: true, from: "2026-01-01", to: "2026-06-30" },
      valueAxis: { show: true, rotate: -30, number: { compact: false }, step: "50", reverse: true, size: 10 },
      legend: { size: 13, title: "Values", position: "bottom-left" },
      gridlines: { style: "dashed", color: "#cccccc" },
      plot: { background: "#fafafa" },
      tooltip: { total: true, show: false },
      referenceLines: [{ kind: "average", series: 0, label: "Average", color: "#990000", style: "dotted" }, { kind: "band", value: "100", to: "200" }],
      bars: { thickness: 30, gap: 20, rounded: false },
    });
    expect(() => parseChartFormat({ series: [{ hex: "red" }] })).toThrow(/colour like/);
    expect(() => parseChartFormat({ card: { title: { size: 80 } } })).toThrow(/Title size/);
    expect(() => parseChartFormat({ card: { opacity: 120 } })).toThrow(/0 to 100/);
    expect(() => parseChartFormat({ categoryAxis: { rotate: 120 } })).toThrow(/-90 to 90/);
    expect(() => parseChartFormat({ categoryAxis: { from: "2026-13-01" } })).toThrow(/YYYY-MM-DD/);
    expect(() => parseChartFormat({ categoryAxis: { from: "2026-06-01", to: "2026-01-01" } })).toThrow(/after/);
    expect(() => parseChartFormat({ legend: { position: "middle" } })).toThrow(/Legend position/);
    expect(() => parseChartFormat({ referenceLines: [{ kind: "guess" }] })).toThrow(/Reference line 1/);
    expect(() => parseChartFormat({ referenceLines: [{ kind: "constant" }] })).toThrow(/value/);
    expect(() => parseChartFormat({ referenceLines: [{ kind: "percentile", percentile: 0 }] })).toThrow(/1 to 99/);
    expect(() => parseChartFormat({ referenceLines: [{ kind: "band", value: "5", to: "1" }] })).toThrow(/more than/);
    expect(() => parseChartFormat({ referenceLines: Array(9).fill({ kind: "average" }) })).toThrow(/up to 8/);
    expect(() => parseChartFormat({ categoryColors: Array(51).fill({ name: "x", color: "#000000" }) })).toThrow(/up to 50/);
    expect(() => parseChartFormat({ series: [{ forecast: 40 }] })).toThrow(/forecast/i);
    expect(() => parseChartFormat({ bars: { thickness: 200 } })).toThrow(/thickness/i);
  });

  it("leaves an old saved format exactly as it was", () => {
    const old = { palette: "warm", series: [{ color: "red", axis: "right" }], legend: { position: "right" }, card: { background: "tinted", border: false } };
    expect(parseChartFormat(old)).toEqual(old);
  });
});

describe("colours", () => {
  it("uses any hex for a value over the theme's colour, and resets to the theme without it", () => {
    const result = option(columns, { series: [{ hex: "#123456", color: "green" }] });
    expect((result.series[0].itemStyle as { color: string }).color).toBe("#123456");
    expect((option(columns, {}).series[0].itemStyle as { color: string }).color).toBe("#1f5fae");
  });

  it("colours chosen groups (any hex) and leaves the others to the theme", () => {
    const single: ChartSpec = { ...columns, series: [columns.series[0]] };
    const result = option(single, { categoryColors: [{ name: "Feb 2026", color: "#ff00aa" }] });
    expect(result.series[0].data[1]).toMatchObject({ itemStyle: { color: "#ff00aa" } });
    expect(result.series[0].data[0]).toBe(100);
    const pie = option({ ...single, kind: "pie" }, { categoryColors: [{ name: "Jan 2026", color: "#ff00aa" }] });
    expect(pie.series[0].data[0]).toMatchObject({ name: "Jan 2026", itemStyle: { color: "#ff00aa" } });
  });
});

describe("data labels", () => {
  it("have their own size, colour and number format, separate from the axis", () => {
    const result = option(columns, { labels: { show: true, size: 15, color: "#aa0000", number: { decimals: 0, compact: false } } });
    const label = result.series[0].label as { fontSize: number; color: string; formatter: (params: { value: number; dataIndex: number }) => string };
    expect(label.fontSize).toBe(15);
    expect(label.color).toBe("#aa0000");
    expect(label.formatter({ value: 1500, dataIndex: 0 })).toBe("$1,500");
    // The axis keeps the value's own format.
    const axis = yAxis(result).axisLabel as { formatter: (value: number) => string };
    expect(axis.formatter(1500)).toBe("$1.5K");
  });

  it("can show only the ends of a line", () => {
    const result = option({ ...columns, kind: "line" }, { labels: { show: true, density: "ends" } });
    const label = result.series[0].label as { formatter: (params: { value: number; dataIndex: number }) => string };
    expect(label.formatter({ value: 100, dataIndex: 0 })).not.toBe("");
    expect(label.formatter({ value: 200, dataIndex: 1 })).toBe("");
    expect(label.formatter({ value: 400, dataIndex: 3 })).not.toBe("");
  });

  it("let a pie show the group, value and percentage in any mix", () => {
    const pie: ChartSpec = { ...columns, kind: "pie", series: [columns.series[0]] };
    const result = option(pie, { labels: { show: true, content: { category: false, value: true, percent: false } } });
    const label = result.series[0].label as { formatter: (params: { name: string; value: number; percent: number }) => string };
    expect(label.formatter({ name: "Jan", value: 100, percent: 10 })).toBe("$100.00");
    const both = option(pie, { labels: { show: true, content: { category: true, value: false, percent: true } } });
    expect((both.series[0].label as typeof label).formatter({ name: "Jan", value: 100, percent: 10 })).toBe("Jan\n10%");
  });
});

describe("axes, legend, gridlines and plot area", () => {
  it("styles, rotates, steps, reverses and hides the axes", () => {
    const result = option(columns, {
      categoryAxis: { size: 11, color: "#444444", rotate: 45, interval: 1, reverse: true },
      valueAxis: { size: 10, color: "#555555", number: { compact: false, decimals: 0 }, step: "100", reverse: true },
    });
    expect(result.xAxis).toMatchObject({ inverse: true, axisLabel: { fontSize: 11, color: "#444444", rotate: 45, interval: 1 } });
    expect(yAxis(result)).toMatchObject({ inverse: true, interval: 100, axisLabel: { fontSize: 10, color: "#555555" } });
    expect((yAxis(result).axisLabel as { formatter: (value: number) => string }).formatter(1500)).toBe("$1,500");
    const hidden = option(columns, { categoryAxis: { show: false }, valueAxis: { show: false } });
    expect(hidden.xAxis).toMatchObject({ show: false });
    expect(yAxis(hidden)).toMatchObject({ show: false });
  });

  it("limits a date axis to a from and to date", () => {
    const result = option(columns, { categoryAxis: { from: "2026-02-01", to: "2026-03-31" } });
    expect(result.xAxis!.data).toEqual(["Feb 2026", "Mar 2026"]);
    expect(result.series[0].data).toHaveLength(2);
  });

  it("puts the legend in any corner or side, with its own size and a title", () => {
    const result = option(columns, { legend: { position: "bottom-left", size: 14, title: "Values" } });
    expect(result.legend).toMatchObject({ bottom: 0, left: 0, textStyle: { fontSize: 14 } });
    const titles = (Array.isArray(result.title) ? result.title : [result.title]) as Array<Record<string, unknown>>;
    expect(titles.some((title) => title.text === "Values")).toBe(true);
    expect(option(columns, { legend: { position: "left" } }).legend).toMatchObject({ left: 0, orient: "vertical" });
    expect(option(columns, { legend: { position: "top-right" } }).legend).toMatchObject({ top: 0, right: 0 });
  });

  it("draws gridlines dashed in a chosen colour, and a plot background", () => {
    const result = option(columns, { gridlines: { style: "dashed", color: "#cccccc" }, plot: { background: "#fafafa" } });
    expect(yAxis(result)).toMatchObject({ splitLine: { lineStyle: { type: "dashed", color: "#cccccc" } } });
    expect(result.grid).toMatchObject({ show: true, backgroundColor: "#fafafa", borderWidth: 0 });
  });
});

describe("tooltips", () => {
  it("can leave a value out, show a value only in the tooltip, add a total, or be off", () => {
    const hidden = option(columns, { series: [{}, { tooltip: "hide" }] });
    const format = hidden.tooltip!.formatter as (params: unknown) => string;
    const html = format([
      { seriesIndex: 0, dataIndex: 0, seriesName: "Sales", axisValueLabel: "Jan 2026" },
      { seriesIndex: 1, dataIndex: 0, seriesName: "Costs", axisValueLabel: "Jan 2026" },
    ]);
    expect(html).toContain("Sales");
    expect(html).not.toContain("Costs");

    const only = option(columns, { series: [{}, { tooltip: "only" }], tooltip: { total: true } });
    // Not drawn (so it doesn't stretch the axis or take a legend entry), but still in the tooltip.
    expect(only.series.map((series) => series.name)).toEqual(["Sales"]);
    const onlyHtml = (only.tooltip!.formatter as (params: unknown) => string)([{ seriesIndex: 0, dataIndex: 0, seriesName: "Sales", axisValueLabel: "Jan 2026" }]);
    expect(onlyHtml).toContain("Costs");
    expect(onlyHtml).toContain("Total");
    expect(onlyHtml).toContain("$140.00");

    expect(option(columns, { tooltip: { show: false } }).tooltip).toMatchObject({ show: false });
  });
});

describe("reference lines, trend and forecast", () => {
  it("works out average, median, min, max and percentiles from the drawn values", () => {
    const values = [100, 200, 300, 400];
    expect(referenceValue({ kind: "average" }, values)).toBe(250);
    expect(referenceValue({ kind: "median" }, values)).toBe(250);
    expect(referenceValue({ kind: "min" }, values)).toBe(100);
    expect(referenceValue({ kind: "max" }, values)).toBe(400);
    expect(referenceValue({ kind: "percentile", percentile: 90 }, values)).toBeCloseTo(370, 6);
    expect(referenceValue({ kind: "constant", value: "275.5" }, values)).toBe(275.5);
    expect(referenceValue({ kind: "average" }, [])).toBeNull();
  });

  it("draws lines and a shaded band on the value axis, labelled", () => {
    const result = option(columns, {
      referenceLines: [
        { kind: "target", value: "350", label: "Target", color: "#990000", style: "dashed" },
        { kind: "average", series: 0 },
        { kind: "band", value: "100", to: "200", color: "#00aa00" },
      ],
    });
    const marks = result.series.find((series) => series.name === "Reference lines")!;
    const markLine = marks.markLine as { data: Array<Record<string, unknown>> };
    expect(markLine.data[0]).toMatchObject({ yAxis: 350, name: "Target", lineStyle: { color: "#990000", type: "dashed" } });
    expect(markLine.data[1]).toMatchObject({ yAxis: 250, name: "Average of Sales" });
    const markArea = marks.markArea as { data: Array<Array<Record<string, unknown>>> };
    expect(markArea.data[0][0]).toMatchObject({ yAxis: 100 });
    expect(markArea.data[0][1]).toMatchObject({ yAxis: 200 });
    // Bars draw reference lines on the x axis.
    const bars = option({ ...columns, kind: "bar" }, { referenceLines: [{ kind: "constant", value: "50" }] });
    expect(((bars.series.find((series) => series.name === "Reference lines")!.markLine as { data: Array<Record<string, unknown>> }).data[0])).toMatchObject({ xAxis: 50 });
  });

  it("fits a straight trend line and carries it forward for a simple forecast", () => {
    expect(trendLine([100, 200, 300, 400], 2)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(trendLine([5], 0)).toEqual([5]);
    const result = option({ ...columns, kind: "line" }, { series: [{ trend: true, forecast: 2 }] });
    expect(result.xAxis!.data).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026"]);
    const trend = result.series.find((series) => series.name === "Sales trend")!;
    expect(trend.data).toEqual([100, 200, 300, 400, 500, 600]);
    expect(trend.lineStyle).toMatchObject({ type: "dashed" });
    // The value itself has nothing in the forecast months.
    expect(result.series[0].data.slice(4)).toEqual([null, null]);
  });
});

describe("bars and lines", () => {
  it("sets column thickness, the gap and square corners", () => {
    const result = option(columns, { bars: { thickness: 40, gap: 10, rounded: false } });
    expect(result.series[0]).toMatchObject({ barMaxWidth: 40, barCategoryGap: "10%" });
    expect((result.series[0].itemStyle as Record<string, unknown>).borderRadius).toBe(0);
  });

  it("sets each line's width, style, steps and markers", () => {
    const result = option({ ...columns, kind: "line" }, { series: [{ lineWidth: 4, lineStyle: "dotted", step: true, markers: false }, { markers: true }] });
    expect(result.series[0]).toMatchObject({ step: "middle", showSymbol: false, lineStyle: { width: 4, type: "dotted" } });
    expect(result.series[1]).toMatchObject({ showSymbol: true });
  });
});

describe("the card", () => {
  it("turns title and card settings into styles, with transparency", () => {
    expect(cardStyle(undefined)).toEqual({ card: {}, title: {}, subtitle: {} });
    const style = cardStyle({ card: { title: { size: 20, bold: false, italic: true, color: "#aa0000", align: "right", background: "#eeeeee" }, subtitleStyle: { size: 13, color: "#555555" }, fill: "#102030", opacity: 50, borderColor: "#ff0000", borderWidth: 3, radius: 0, shadow: "strong", padding: 24 } });
    expect(style.title).toMatchObject({ fontSize: "20px", fontWeight: 400, fontStyle: "italic", textAlign: "right", padding: "2px 6px", borderRadius: "4px" });
    expect(style.title.color).toMatch(/^light-dark\(#aa0000, /);
    expect(style.title.background).toMatch(/^light-dark\(#eeeeee, /);
    expect(style.subtitle.fontSize).toBe("13px");
    expect(style.subtitle.color).toMatch(/^light-dark\(#555555, /);
    expect(style.card).toMatchObject({ borderWidth: "3px", borderRadius: "0px", padding: "24px" });
    // A dark fill is its own dark version; the transparency applies in both modes.
    expect(style.card.background).toBe("light-dark(rgba(16, 32, 48, 0.5), rgba(16, 32, 48, 0.5))");
    expect(style.card.borderColor).toMatch(/^light-dark\(#ff0000, /);
    expect(style.card.boxShadow).toContain("rgba");
  });
});

describe("checking chosen colours (decision 668: warn, don't block)", () => {
  it("says nothing when the theme's colours are used", () => {
    expect(chosenColourWarnings([undefined, undefined], BUILT_IN_THEMES.tohyee)).toEqual([]);
  });

  it("warns about a faint colour and one too close to its neighbour, in light and dark", () => {
    const warnings = chosenColourWarnings(["#f4f4f4", undefined], BUILT_IN_THEMES.tohyee);
    expect(warnings.some((warning) => warning.startsWith("Light: value 1's colour"))).toBe(true);
    const twins = chosenColourWarnings(["#1f5fae", "#2060b0"], BUILT_IN_THEMES.tohyee);
    expect(twins.some((warning) => warning.startsWith("Light: values 1 and 2 look nearly the same"))).toBe(true);
    expect(twins.some((warning) => warning.startsWith("Dark: values 1 and 2"))).toBe(true);
    // In dark mode the colour is drawn as its dark version (decision 672), so a blue that's dim on the dark card isn't flagged.
    expect(chosenColourWarnings(["#1f5fae", undefined], BUILT_IN_THEMES.tohyee)).toEqual([]);
    expect(chosenColourWarnings(["#d66919", "#3a7bd5"], BUILT_IN_THEMES.tohyee)).toEqual([]);
  });
});

describe("chosen colours in dark mode (decision 672)", () => {
  it("works out a dark version: marks in the dark band, backgrounds dark, text that reads", async () => {
    const { adaptForDark, contrast, oklch } = await import("@/lib/charts/colour-check");
    // Already fine on the dark card: unchanged.
    expect(adaptForDark("#518fe9", "mark")).toBe("#518fe9");
    const mark = adaptForDark("#2a6f97", "mark");
    expect(oklch(mark).l).toBeGreaterThanOrEqual(0.48);
    expect(Math.abs(oklch(mark).h - oklch("#2a6f97").h)).toBeLessThan(6);
    expect(oklch(adaptForDark("#fff7e6", "surface")).l).toBeLessThan(0.36);
    expect(contrast(adaptForDark("#2a6f97", "text"), "#121925")).toBeGreaterThanOrEqual(4.5);
    expect(adaptForDark("#e4e9f1", "text")).toBe("#e4e9f1");
  });

  it("uses the dark versions when the chart is drawn on a dark card", () => {
    const dark: ChartTheme = { ...theme, background: "#121925", text: "#e4e9f1", mutedText: "#9ba6b6" };
    const result = toEChartsOption({ ...columns, format: { series: [{ hex: "#1d3557" }], plot: { background: "#f6f8fb" }, labels: { show: true, color: "#2a6f97" } } }, months, dark) as unknown as AnyOption;
    const colour = (result.series[0].itemStyle as { color: string }).color;
    expect(colour).not.toBe("#1d3557");
    expect((result.grid as { backgroundColor: string }).backgroundColor).not.toBe("#f6f8fb");
    expect((result.series[0].label as { color: string }).color).not.toBe("#2a6f97");
    // Light is unchanged.
    expect((option(columns, { series: [{ hex: "#2a6f97" }] }).series[0].itemStyle as { color: string }).color).toBe("#2a6f97");
  });

  it("gives the card light and dark colours", () => {
    const style = cardStyle({ card: { fill: "#fff7e6", title: { color: "#2a6f97" } } });
    expect(String(style.card.background)).toMatch(/^light-dark\(#fff7e6, #[0-9a-f]{6}\)$/);
    expect(String(style.title.color)).toMatch(/^light-dark\(#2a6f97, #[0-9a-f]{6}\)$/);
  });
});
