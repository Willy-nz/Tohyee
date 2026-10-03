import { describe, expect, it } from "vitest";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";

const theme: ChartTheme = {
  text: "#15201c",
  mutedText: "#57635e",
  grid: "#e1e6e3",
  background: "#ffffff",
  palette: ["#0e7467", "#b45309"],
};

type TestOption = {
  series: Array<{
    type: string;
    data?: Array<{ name?: string; value?: number | null } | number | null>;
    stack?: string;
    areaStyle?: unknown;
    yAxisIndex?: number;
    radius?: string[];
  }>;
  xAxis?: { data?: string[] };
  yAxis?: Array<{ position?: string; axisLabel?: { formatter?: (value: number) => string } }>;
  tooltip?: { valueFormatter?: (value: number | string) => string };
};

function asOption(spec: ChartSpec, rows: Record<string, string | number | null>[]) {
  const result = toEChartsOption(spec, rows, theme);
  expect("series" in result).toBe(true);
  return result as TestOption;
}

describe("analytics chart specs", () => {
  it.each([
    ["bar", "bar"],
    ["column", "bar"],
    ["line", "line"],
    ["area", "line"],
    ["combo", "bar"],
  ] as const)("creates a %s chart", (kind, type) => {
    const option = asOption(
      { kind, category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "number" },
      [{ month: "Jan", sales: "12.5" }],
    );
    expect(option.series[0].type).toBe(type);
    expect(option.series[0].data).toEqual([12.5]);
  });

  it.each(["pie", "donut"] as const)("creates a %s chart with named slices", (kind) => {
    const option = asOption(
      { kind, category: "region", series: [{ field: "sales", label: "Sales" }], valueFormat: "money", currency: "NZD" },
      [{ region: "Auckland", sales: "1234.50" }],
    );
    expect(option.series[0]).toMatchObject({
      type: "pie",
      data: [{ name: "Auckland", value: 1234.5 }],
    });
    expect(option.series[0].radius).toEqual(kind === "donut" ? ["45%", "70%"] : ["0%", "70%"]);
  });

  it("formats money compactly on axes and fully in tooltips", () => {
    const option = asOption(
      { kind: "column", category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "money", currency: "NZD" },
      [{ month: "Jan", sales: "1234567.89" }],
    );
    expect(option.yAxis?.[0].axisLabel?.formatter?.(1_234_567.89)).toBe("$1.2M");
    expect(option.tooltip?.valueFormatter?.(1234.5)).toBe("$1,234.50");
  });

  it("formats first-of-month dates as months and other dates with their day", () => {
    expect(
      asOption(
        { kind: "line", category: "date", series: [{ field: "sales", label: "Sales" }], valueFormat: "number" },
        [{ date: "2026-01-01", sales: "1" }, { date: "2026-02-01", sales: "2" }],
      ).xAxis?.data,
    ).toEqual(["Jan 2026", "Feb 2026"]);
    expect(
      asOption(
        { kind: "line", category: "date", series: [{ field: "sales", label: "Sales" }], valueFormat: "number" },
        [{ date: "2026-01-05", sales: "1" }],
      ).xAxis?.data,
    ).toEqual(["5 Jan 2026"]);
  });

  it("keeps null values as gaps", () => {
    const option = asOption(
      { kind: "line", category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "number" },
      [{ month: "Jan", sales: null }, { month: "Feb", sales: "2" }],
    );
    expect(option.series[0].data).toEqual([null, 2]);
  });

  it("stacks series when requested", () => {
    const option = asOption(
      {
        kind: "column",
        category: "month",
        series: [{ field: "sales", label: "Sales" }, { field: "costs", label: "Costs" }],
        stacked: true,
        valueFormat: "money",
      },
      [{ month: "Jan", sales: "10", costs: "5" }],
    );
    expect(option.series.map((series) => series.stack)).toEqual(["total", "total"]);
  });

  it("puts combo series on their selected axes", () => {
    const option = asOption(
      {
        kind: "combo",
        category: "month",
        series: [
          { field: "sales", label: "Sales", as: "bar" },
          { field: "margin", label: "Margin", as: "line", axis: "right" },
        ],
        valueFormat: "money",
      },
      [{ month: "Jan", sales: "10", margin: "0.2" }],
    );
    expect(option.series.map((series) => series.yAxisIndex)).toEqual([0, 1]);
    expect(option.yAxis?.map((axis) => axis.position)).toEqual(["left", "right"]);
  });

  it("throws a clear error when a named field is missing", () => {
    const spec: ChartSpec = { kind: "line", category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "number" };
    expect(() =>
      toEChartsOption(
        spec,
        [{ month: "Jan", total: "1" }],
        theme,
      ),
    ).toThrow('Chart field "sales" is missing from the rows.');
    expect(() =>
      toEChartsOption(spec, [{ month: "Jan", sales: "1" }, { month: "Feb" }], theme),
    ).toThrow('Chart field "sales" is missing from the rows.');
  });

  it("computes KPI changes exactly with decimal arithmetic", () => {
    expect(
      toEChartsOption(
        {
          kind: "kpi",
          category: "period",
          series: [{ field: "value", label: "Value" }, { field: "previous", label: "Previous" }],
          valueFormat: "money",
        },
        [{ period: "Jan", value: "0.30", previous: "0.10" }],
        theme,
      ),
    ).toEqual({ value: "0.30", previous: "0.10", change: "0.20" });
  });
});
