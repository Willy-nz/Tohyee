import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HUES, PALETTES } from "@/lib/analytics/chart-format";
import { chartColours, inkOn, toEChartsOption, type ChartSpec } from "@/lib/analytics/chart-spec";
import {
  barRadius,
  CHART_TOKENS,
  chartThemeFromTokens,
  chartVariables,
  echartsBase,
  MARKS,
  readChartTheme,
  tooltipHtml,
} from "@/lib/charts/theme";

const light = chartThemeFromTokens(CHART_TOKENS.light);
const dark = chartThemeFromTokens(CHART_TOKENS.dark);

type AnyOption = Record<string, unknown> & {
  color: string[];
  series: Array<Record<string, unknown> & { data: unknown[]; itemStyle?: Record<string, unknown>; lineStyle?: Record<string, unknown>; areaStyle?: Record<string, unknown> }>;
  xAxis?: Record<string, unknown>;
  yAxis?: Array<Record<string, unknown>>;
  legend?: Record<string, unknown>;
  tooltip?: Record<string, unknown>;
};

const months = [
  { month: "2026-01-01", sales: "1500.00", costs: "-200.00" },
  { month: "2026-02-01", sales: "-250.00", costs: "-300.00" },
];
const twoValues: ChartSpec = {
  kind: "column",
  category: "month",
  series: [
    { field: "sales", label: "Sales", kind: "money" },
    { field: "costs", label: "Costs", kind: "money" },
  ],
  valueFormat: "money",
};

function option(spec: ChartSpec, theme = light) {
  return toEChartsOption(spec, months, theme) as unknown as AnyOption;
}

describe("chart theme tokens (decision 599)", () => {
  it("has eight series colours in the checked order, Tohyee blue first, in both themes", () => {
    for (const tokens of [CHART_TOKENS.light, CHART_TOKENS.dark]) {
      expect(tokens.series).toHaveLength(8);
      expect(new Set(tokens.series).size).toBe(8);
      expect(tokens.blues).toHaveLength(4);
      expect(tokens.sequential).toHaveLength(7);
    }
    // Light slot 1 is the brand's accent blue.
    expect(CHART_TOKENS.light.series[0]).toBe("#1f5fae");
    expect(HUES[0]).toBe("blue");
    expect(PALETTES.tohyee.order).toEqual([...HUES]);
  });

  it("has its own dark values, not the light ones", () => {
    CHART_TOKENS.light.series.forEach((colour, index) => expect(CHART_TOKENS.dark.series[index]).not.toBe(colour));
    expect(CHART_TOKENS.dark.surface).toBe("#121925");
    expect(CHART_TOKENS.light.surface).toBe("#ffffff");
    // The sequential ramp flips so small amounts sit near the surface in both.
    expect(CHART_TOKENS.dark.sequential).toEqual([...CHART_TOKENS.light.sequential].reverse());
  });

  it("keeps the status colours apart from the series colours", () => {
    for (const tokens of [CHART_TOKENS.light, CHART_TOKENS.dark]) {
      for (const status of [tokens.status.good, tokens.status.warning, tokens.status.critical]) expect(tokens.series).not.toContain(status);
    }
  });

  it("matches the --chart-* variables in globals.css, light and dark", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"] {'));
    const mediaBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf(':root[data-theme="dark"] {'));
    const valueIn = (block: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1].trim();
    for (const [name, value] of Object.entries(chartVariables(CHART_TOKENS.light))) expect(valueIn(rootBlock, name), name).toBe(value);
    for (const [name, value] of Object.entries(chartVariables(CHART_TOKENS.dark))) {
      expect(valueIn(darkBlock, name), name).toBe(value);
      expect(valueIn(mediaBlock, name), name).toBe(value);
    }
  });

  it("reads the theme from the page's variables, falling back to the light tokens", () => {
    const fromDark = readChartTheme((name) => chartVariables(CHART_TOKENS.dark)[name] ?? "");
    expect(fromDark.palette).toEqual(CHART_TOKENS.dark.series);
    expect(fromDark.blues).toEqual(CHART_TOKENS.dark.blues);
    expect(fromDark.background).toBe("#121925");
    expect(fromDark.negative).toBe(CHART_TOKENS.dark.status.critical);
    const empty = readChartTheme(() => "");
    expect(empty).toEqual(light);
    expect(readChartTheme((name) => (name === "--font" ? " Inter, sans-serif " : "")).font).toBe("Inter, sans-serif");
  });
});

describe("chart look from the theme", () => {
  it("uses the default colour set in fixed order, and follows the theme", () => {
    expect(option(twoValues).color).toEqual(CHART_TOKENS.light.series);
    expect(option(twoValues, dark).color).toEqual(CHART_TOKENS.dark.series);
    expect(chartColours(light, {}, 3)).toEqual(CHART_TOKENS.light.series);
    expect(chartColours(light, { palette: "blues" }, 3)).toEqual(CHART_TOKENS.light.blues);
    expect(chartColours(light, { palette: "warm" }, 3).slice(0, 2)).toEqual([CHART_TOKENS.light.series[1], CHART_TOKENS.light.series[0]]);
  });

  it("keeps a saved colour for a value over the default set (#333)", () => {
    const saved = option({ ...twoValues, format: { series: [{ color: "green" }, { color: "violet" }] } });
    expect(saved.series[0].itemStyle?.color).toBe(CHART_TOKENS.light.series[HUES.indexOf("green")]);
    expect(saved.series[1].itemStyle?.color).toBe(CHART_TOKENS.light.series[HUES.indexOf("violet")]);
    // The same saved name gives the dark step in dark mode.
    const savedDark = option({ ...twoValues, format: { series: [{ color: "green" }] } }, dark);
    expect(savedDark.series[0].itemStyle?.color).toBe(CHART_TOKENS.dark.series[HUES.indexOf("green")]);
    // A value with no saved colour keeps its place in the set.
    const partly = option({ ...twoValues, format: { series: [{ color: "red" }] } });
    expect(partly.series[1].itemStyle?.color).toBe(CHART_TOKENS.light.series[1]);
  });

  it("draws thin columns with a rounded data end, and red below zero from the status colour", () => {
    const result = option({ ...twoValues, format: { negativeRed: true } });
    expect(result.series[0]).toMatchObject({ barMaxWidth: MARKS.barMaxWidth, itemStyle: { borderRadius: [4, 4, 0, 0] } });
    expect(result.series[0].data[1]).toEqual({ value: -250, itemStyle: { color: CHART_TOKENS.light.status.critical, borderRadius: [0, 0, 4, 4] } });
    expect(barRadius(true, false)).toEqual([0, 4, 4, 0]);
    expect(barRadius(true, true)).toEqual([4, 0, 0, 4]);
  });

  it("separates stacked segments with a 2px gap in the surface colour", () => {
    const result = option({ ...twoValues, format: { stack: "stacked" } });
    expect(result.series[0].itemStyle).toMatchObject({ borderColor: CHART_TOKENS.light.surface, borderWidth: 1 });
    expect(result.series[0].itemStyle?.borderRadius).toBeUndefined();
  });

  it("draws 2px lines with ringed dots and a light wash under areas", () => {
    const line = option({ ...twoValues, kind: "area" });
    expect(line.series[0].lineStyle).toMatchObject({ width: 2, cap: "round", join: "round" });
    expect(line.series[0].itemStyle).toMatchObject({ borderColor: CHART_TOKENS.light.surface, borderWidth: 2 });
    expect(line.series[0].areaStyle).toMatchObject({ opacity: MARKS.areaOpacity, color: CHART_TOKENS.light.series[0] });
    // Few points: dots shown; the person's choice still wins.
    expect(line.series[0].showSymbol).toBe(true);
    expect(option({ ...twoValues, kind: "line", format: { markers: false } }).series[0].showSymbol).toBe(false);
    // A small pinned chart hides dots on a busy line but keeps them for a point or two, so one month still shows.
    const year = Array.from({ length: 12 }, (_value, index) => ({ month: `2026-${String(index + 1).padStart(2, "0")}-01`, sales: "1", costs: "1" }));
    const pinned = (rows: typeof year) => (toEChartsOption({ ...twoValues, kind: "line", compact: true }, rows, light) as unknown as AnyOption).series[0].showSymbol;
    expect(pinned(year)).toBe(false);
    expect(pinned(year.slice(0, 1))).toBe(true);
  });

  it("keeps gridlines and axes quiet and text in text colours", () => {
    const result = option({ ...twoValues, format: { labels: { show: true } } });
    const valueAxis = result.yAxis![0] as { axisLine: { show: boolean }; splitLine: { lineStyle: { color: string; type: string } }; axisLabel: { color: string } };
    expect(valueAxis.axisLine.show).toBe(false);
    expect(valueAxis.splitLine.lineStyle).toMatchObject({ color: CHART_TOKENS.light.grid, type: "solid" });
    expect(valueAxis.axisLabel.color).toBe(CHART_TOKENS.light.mutedText);
    expect(result.xAxis).toMatchObject({ axisLine: { lineStyle: { color: CHART_TOKENS.light.axis } } });
    // Data labels never wear the series colour.
    const label = result.series[0].label as { color: string };
    expect(CHART_TOKENS.light.series).not.toContain(label.color);
    expect(result.legend).toMatchObject({ textStyle: { color: CHART_TOKENS.light.secondaryText } });
  });

  it("shows a legend only for two or more values", () => {
    expect(option(twoValues).legend).toMatchObject({ show: true });
    expect(option({ ...twoValues, series: [twoValues.series[0]] }).legend).toMatchObject({ show: false });
  });

  it("uses the same tooltip everywhere: a crosshair on lines, a band on columns", () => {
    expect(option({ ...twoValues, kind: "line" }).tooltip).toMatchObject({ axisPointer: { type: "line" }, backgroundColor: CHART_TOKENS.light.surface });
    expect(option(twoValues).tooltip).toMatchObject({ axisPointer: { type: "shadow" } });
    const html = tooltipHtml(light, "Jan <2026>", [{ colour: "#1f5fae", name: "A & B", value: "$1.00", line: true }]);
    expect(html).toContain("Jan &lt;2026&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("height:2px");
    expect(echartsBase(dark).tooltip.backgroundColor).toBe("#121925");
  });

  it("picks white or dark ink for labels inside a fill", () => {
    expect(inkOn("#1f5fae")).toBe("#ffffff");
    expect(inkOn("#e2a520")).toBe("#0b1018");
  });
});
