import { describe, expect, it } from "vitest";
import { makeNumberFormatter, parseChartFormat } from "@/lib/analytics/chart-format";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";

const theme: ChartTheme = {
  text: "#1b2533",
  mutedText: "#546072",
  grid: "#dde2e9",
  background: "#ffffff",
  palette: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  blues: ["#0d366b", "#256abf", "#5598e7", "#86b6ef"],
  negative: "#d03b3b",
};

type AnyOption = Record<string, unknown> & {
  series: Array<Record<string, unknown> & { data: unknown[] }>;
  yAxis?: Array<Record<string, unknown>>;
  xAxis?: Record<string, unknown>;
  legend?: Record<string, unknown>;
  tooltip?: Record<string, unknown>;
  graphic?: Array<{ children: Array<{ style: { text: string } }> }>;
};

function option(spec: ChartSpec, rows: Record<string, string | null>[]) {
  return toEChartsOption(spec, rows, theme) as unknown as AnyOption;
}

const months = [
  { month: "2026-01-01", sales: "1500.00", invoices: "3" },
  { month: "2026-02-01", sales: "-250.00", invoices: "1" },
];
const combo: ChartSpec = {
  kind: "combo",
  category: "month",
  series: [
    { field: "sales", label: "Sales", kind: "money" },
    { field: "invoices", label: "Invoices", kind: "number" },
  ],
  valueFormat: "money",
};

describe("chart format settings (#333)", () => {
  it("keeps only known settings and refuses wrong values", () => {
    expect(parseChartFormat(undefined)).toBeUndefined();
    expect(parseChartFormat({ palette: "warm", nonsense: 1, series: [{ color: "red", axis: "right" }, {}] })).toEqual({
      palette: "warm",
      series: [{ color: "red", axis: "right" }],
    });
    expect(parseChartFormat({})).toBeUndefined();
    expect(() => parseChartFormat({ palette: "rainbow" })).toThrow("Colours");
    expect(() => parseChartFormat({ series: [{ color: "#ff0000" }] })).toThrow("colour");
    expect(() => parseChartFormat({ valueAxis: { min: "abc" } })).toThrow("number");
    expect(() => parseChartFormat({ valueAxis: { min: "10", max: "5" } })).toThrow("maximum");
    expect(() => parseChartFormat({ series: [{ number: { decimals: 7 } }] })).toThrow("0 to 4");
    expect(() => parseChartFormat({ card: { subtitle: "x".repeat(201) } })).toThrow("200");
    expect(() => parseChartFormat({ kpi: { compare: "target" } })).toThrow("target");
    expect(parseChartFormat({ kpi: { compare: "target", target: 5000 } })).toEqual({ kpi: { compare: "target", target: "5000" } });
  });

  it("formats numbers: compact or full, decimals, currency, percent, plain, separators, prefix and suffix", () => {
    expect(makeNumberFormatter(undefined, "money")("1500")).toBe("$1,500.00");
    expect(makeNumberFormatter(undefined, "money")("-27")).toBe("-$27.00");
    expect(makeNumberFormatter({ compact: true }, "money")("1500")).toBe("$1.5K");
    expect(makeNumberFormatter({ decimals: 0 }, "money")("1500.40")).toBe("$1,500");
    expect(makeNumberFormatter({ style: "plain" }, "money")("1500.5")).toBe("1,500.5");
    expect(makeNumberFormatter({ style: "plain", thousands: false }, "number")("1500")).toBe("1500");
    expect(makeNumberFormatter({ style: "percent", decimals: 1 }, "number")("0.4237")).toBe("42.4%");
    expect(makeNumberFormatter({ suffix: "customers" }, "number")("12")).toBe("12 customers");
    expect(makeNumberFormatter({ prefix: "≈" }, "number")("12")).toBe("≈12");
    expect(makeNumberFormatter(undefined, "number", { axis: true })("1234567")).toBe("1.2M");
    expect(makeNumberFormatter(undefined, "number")(null)).toBe("");
  });
});

describe("second axis (#331)", () => {
  it("puts each value on its chosen axis, drawn as a column or a line, with the right axis's own format", () => {
    const result = option({ ...combo, format: { series: [{}, { as: "line", axis: "right" }] } }, months);
    expect(result.series.map((series) => [series.type, series.yAxisIndex, series.name])).toEqual([
      ["bar", 0, "Sales"],
      ["line", 1, "Invoices (right axis)"],
    ]);
    const [left, right] = result.yAxis!;
    expect((left.axisLabel as { formatter: (value: number) => string }).formatter(1500)).toBe("$1.5K");
    expect((right.axisLabel as { formatter: (value: number) => string }).formatter(3)).toBe("3");
    expect(right.position).toBe("right");
    // The right axis has no gridlines of its own, so the two scales' lines don't cross.
    expect((right.splitLine as { show: boolean }).show).toBe(false);
  });

  it("lets a value be a column or a line regardless of position", () => {
    const result = option({ ...combo, format: { series: [{ as: "line" }, { as: "bar" }] } }, months);
    expect(result.series.map((series) => series.type)).toEqual(["line", "bar"]);
    expect(result.yAxis).toHaveLength(1);
  });

  it("gives line and area charts a right axis too, but not columns", () => {
    for (const kind of ["line", "area"] as const) {
      const result = option({ ...combo, kind, format: { series: [{}, { axis: "right" }] } }, months);
      expect(result.series.map((series) => series.yAxisIndex)).toEqual([0, 1]);
    }
    const columns = option({ ...combo, kind: "column", format: { series: [{}, { axis: "right" }] } }, months);
    expect(columns.yAxis).toHaveLength(1);
    expect(columns.series[1].yAxisIndex).toBeUndefined();
  });

  it("shows each value in its own format in the tooltip, escaping names", () => {
    const result = option(
      { ...combo, series: [{ ...combo.series[0], label: "<b>Sales</b>" }, combo.series[1]], format: { series: [{}, { axis: "right" }] } },
      months,
    );
    const formatter = result.tooltip!.formatter as (params: unknown) => string;
    const html = formatter([
      { seriesIndex: 0, dataIndex: 0, marker: "", seriesName: "<b>Sales</b>", axisValueLabel: "Jan 2026" },
      { seriesIndex: 1, dataIndex: 0, marker: "", seriesName: "Invoices (right axis)", axisValueLabel: "Jan 2026" },
    ]);
    expect(html).toBe("Jan 2026<br/>&lt;b&gt;Sales&lt;/b&gt;: <b>$1,500.00</b><br/>Invoices (right axis): <b>3</b>");
  });
});

describe("chart look (#333)", () => {
  const columns: ChartSpec = { kind: "column", category: "month", series: [{ field: "sales", label: "Sales", kind: "money" }], valueFormat: "money" };

  it("uses the Tohyee colours by default, presets in their checked order, and a chosen colour per value", () => {
    expect(option(combo, months).color).toEqual(theme.palette);
    expect((option({ ...combo, format: { palette: "warm" } }, months).color as string[]).slice(0, 2)).toEqual(["#eb6834", "#2a78d6"]);
    expect(option({ ...combo, format: { palette: "blues" } }, months).color).toEqual(theme.blues);
    const chosen = option({ ...combo, format: { series: [{ color: "green" }] } }, months);
    expect((chosen.series[0].itemStyle as { color: string }).color).toBe("#008300");
  });

  it("falls back to the full colours when Tohyee blues has too few for the values", () => {
    const many: ChartSpec = { ...columns, series: ["a", "b", "c", "d", "e"].map((field) => ({ field, label: field })) };
    const rows = [{ month: "Jan", a: "1", b: "1", c: "1", d: "1", e: "1" }];
    expect(option({ ...many, format: { palette: "blues" } }, rows).color).toEqual(theme.palette);
  });

  it("colours columns by group, and below-zero columns red", () => {
    const byGroup = option({ ...columns, format: { colorByCategory: true } }, months);
    expect(byGroup.series[0].data).toEqual([
      { value: 1500, itemStyle: { color: "#2a78d6" } },
      { value: -250, itemStyle: { color: "#eb6834" } },
    ]);
    const red = option({ ...columns, format: { negativeRed: true } }, months);
    expect(red.series[0].data).toEqual([1500, { value: -250, itemStyle: { color: "#d03b3b" } }]);
  });

  it("shows data labels in the value's format", () => {
    const result = option({ ...columns, format: { labels: { show: true }, series: [{ number: { compact: false, decimals: 0 } }] } }, months);
    const label = result.series[0].label as { show: boolean; position: string; formatter: (params: { value: number }) => string };
    expect(label.show).toBe(true);
    expect(label.position).toBe("top");
    expect(label.formatter({ value: 1500 })).toBe("$1,500");
  });

  it("places or hides the legend", () => {
    expect(option(combo, months).legend).toMatchObject({ show: true, top: 0 });
    expect(option({ ...combo, format: { legend: { show: "hide" } } }, months).legend).toMatchObject({ show: false });
    expect(option({ ...combo, format: { legend: { position: "right" } } }, months).legend).toMatchObject({ show: true, right: 0, orient: "vertical" });
    expect(option({ ...combo, format: { legend: { position: "bottom" } } }, months).grid).toMatchObject({ bottom: 52 });
  });

  it("sets axis titles, gridlines, bounds, start at zero and log scale", () => {
    const result = option(
      {
        ...columns,
        format: {
          valueAxis: { title: "Dollars", gridlines: false, min: "-500", max: "2000", zero: false },
          categoryAxis: { title: "Month", gridlines: true },
        },
      },
      months,
    );
    expect(result.yAxis![0]).toMatchObject({ name: "Dollars", min: -500, max: 2000, scale: true, splitLine: { show: false } });
    expect(result.xAxis).toMatchObject({ name: "Month", splitLine: { show: true } });
    expect(option({ ...columns, format: { valueAxis: { log: true } } }, months).yAxis![0].type).toBe("log");
    expect(option(columns, months).yAxis![0].scale).toBeUndefined();
  });

  it("stacks to 100% with each value's share", () => {
    const spec: ChartSpec = {
      kind: "column",
      category: "month",
      series: [{ field: "a", label: "A" }, { field: "b", label: "B" }],
      valueFormat: "number",
      format: { stack: "percent" },
    };
    const result = option(spec, [{ month: "Jan", a: "30", b: "10" }]);
    expect(result.series.map((series) => series.data)).toEqual([[0.75], [0.25]]);
    expect(result.yAxis![0]).toMatchObject({ max: 1 });
    expect((result.yAxis![0].axisLabel as { formatter: (value: number) => string }).formatter(0.5)).toBe("50%");
  });

  it("draws smooth lines without markers when asked", () => {
    const result = option({ ...columns, kind: "line", format: { smooth: true, markers: false } }, months);
    expect(result.series[0]).toMatchObject({ smooth: true, showSymbol: false });
  });

  it("shows a donut's exact total in the middle", () => {
    const donut: ChartSpec = { kind: "donut", category: "month", series: [{ field: "sales", label: "Sales", kind: "money" }], valueFormat: "money", format: { donutTotal: true } };
    const result = option(donut, [{ month: "A", sales: "0.10" }, { month: "B", sales: "0.20" }]);
    expect(result.graphic![0].children.map((child) => child.style.text)).toEqual(["$0.30", "Total"]);
  });

  it("draws bars top to bottom in the tile's order", () => {
    expect(option({ ...columns, kind: "bar" }, months).yAxis).toMatchObject({ inverse: true });
  });
});
