import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { toEChartsOption, type ChartSpec } from "@/lib/analytics/chart-spec";
import { cellLook, columnRange, fieldColour, ruleMatches, scaleColour, tableTotals, visiblePivotRows } from "@/lib/analytics/conditional";
import type { PivotRow, ResultColumn } from "@/lib/analytics/query";

/** Conditional formatting and table styles (#376 phase 1, part 4). */

describe("checking the settings", () => {
  it("keeps known settings and refuses wrong ones", () => {
    const parsed = parseChartFormat({
      conditional: [
        { value: 0, apply: "background", by: "scale", low: "#FFFFFF", mid: "#ffeeaa", high: "#057836", junk: 1 },
        { value: 1, apply: "font", by: "rules", rules: [{ op: "<", value: "0", color: "#ba3e3c" }] },
        { value: 0, apply: "background", by: "field", field: "category" },
      ],
      dataBars: [{ value: 0, color: "#1f5fae" }],
      icons: [{ value: 1, set: "arrows" }],
      chartRules: [{ op: "<", value: "5000", color: "#ba3e3c", series: 0 }],
      table: { headerBackground: "#1f5fae", headerColor: "#ffffff", banded: true, bandColor: "#f5f7fa", gridlines: "rows", fontSize: 13, columnWidth: 140, wrap: true, totals: true, totalsStyle: "shaded", subtotalsOff: [2], mystery: true },
    });
    expect(parsed).toEqual({
      conditional: [
        { value: 0, apply: "background", by: "scale", low: "#ffffff", mid: "#ffeeaa", high: "#057836" },
        { value: 1, apply: "font", by: "rules", rules: [{ op: "<", value: "0", color: "#ba3e3c" }] },
        { value: 0, apply: "background", by: "field", field: "category" },
      ],
      dataBars: [{ value: 0, color: "#1f5fae" }],
      icons: [{ value: 1, set: "arrows" }],
      chartRules: [{ op: "<", value: "5000", color: "#ba3e3c", series: 0 }],
      table: { headerBackground: "#1f5fae", headerColor: "#ffffff", banded: true, bandColor: "#f5f7fa", gridlines: "rows", fontSize: 13, columnWidth: 140, wrap: true, totals: true, totalsStyle: "shaded", subtotalsOff: [2] },
    });
    expect(() => parseChartFormat({ conditional: [{ value: 0, apply: "border", by: "scale", low: "#000000", high: "#ffffff" }] })).toThrow(/Conditional format 1/);
    expect(() => parseChartFormat({ conditional: [{ value: 0, apply: "font", by: "scale", low: "#000000" }] })).toThrow(/two colours/);
    expect(() => parseChartFormat({ conditional: [{ value: 0, apply: "font", by: "rules" }] })).toThrow(/rule/);
    expect(() => parseChartFormat({ conditional: [{ value: 0, apply: "font", by: "field" }] })).toThrow(/field/);
    expect(() => parseChartFormat({ conditional: Array(11).fill({ value: 0, apply: "font", by: "scale", low: "#000000", high: "#ffffff" }) })).toThrow(/up to 10/);
    expect(() => parseChartFormat({ icons: [{ value: 0, set: "emoji" }] })).toThrow(/Icon set/);
    expect(() => parseChartFormat({ table: { fontSize: 40 } })).toThrow(/10 to 18/);
    expect(() => parseChartFormat({ table: { subtotalsOff: [9] } })).toThrow(/level/);
    expect(() => parseChartFormat({ chartRules: [{ op: "<", value: "x", color: "#000000" }] })).toThrow(/number/);
  });
});

describe("rules and colour scales", () => {
  it("compares rule values exactly", () => {
    expect(ruleMatches({ op: ">=", value: "1000", color: "#000000" }, "1000.00")).toBe(true);
    expect(ruleMatches({ op: ">=", value: "1000", color: "#000000" }, "999.999")).toBe(false);
    expect(ruleMatches({ op: "=", value: "0.1", color: "#000000" }, "0.10")).toBe(true);
  });

  it("blends two or three colours across the column's range", () => {
    expect(scaleColour({ low: "#000000", high: "#ffffff" }, 0)).toBe("#000000");
    expect(scaleColour({ low: "#000000", high: "#ffffff" }, 1)).toBe("#ffffff");
    expect(scaleColour({ low: "#000000", high: "#ffffff" }, 0.5)).toBe("#808080");
    expect(scaleColour({ low: "#ff0000", mid: "#00ff00", high: "#0000ff" }, 0.5)).toBe("#00ff00");
    expect(scaleColour({ low: "#ff0000", mid: "#00ff00", high: "#0000ff" }, 0.25)).toBe("#808000");
  });

  it("finds a column's range, ignoring blanks and totals", () => {
    expect(columnRange(["10", null, "-5", "20"])).toEqual({ low: -5, high: 20 });
    expect(columnRange([null])).toBeNull();
  });

  it("takes a colour from a field only when it is one", () => {
    expect(fieldColour("#AA0000")).toBe("#aa0000");
    expect(fieldColour("red")).toBe("#d03b3b");
    expect(fieldColour("Otago")).toBeNull();
    expect(fieldColour("#fff;}")).toBeNull();
  });
});

describe("a cell's look", () => {
  const format = parseChartFormat({
    conditional: [
      { value: 0, apply: "background", by: "scale", low: "#ffffff", high: "#000000" },
      { value: 0, apply: "font", by: "rules", rules: [{ op: "<", value: "0", color: "#ba3e3c" }] },
    ],
    dataBars: [{ value: 0 }],
    icons: [{ value: 0, set: "arrows" }],
  })!;
  const range = { low: 0, high: 100 };

  it("combines background, font, data bar and icon", () => {
    const look = cellLook(format, 0, "75", range, null);
    expect(look.background).toBe(scaleColour({ low: "#ffffff", high: "#000000" }, 0.75));
    expect(look.bar).toEqual({ percent: 75, color: undefined });
    expect(look.icon).toEqual({ glyph: "▲", label: "high", tone: "good" });
    // Readable text on the fill when no font colour was chosen.
    expect(look.color).toBe("#ffffff");
    const low = cellLook(format, 0, "10", range, null);
    expect(low.icon).toEqual({ glyph: "▼", label: "low", tone: "bad" });
    const negative = cellLook(format, 0, "-1", { low: -1, high: 100 }, null);
    expect(negative.color).toBe("#ba3e3c");
  });

  it("leaves other values and blanks alone", () => {
    expect(cellLook(format, 1, "75", range, null)).toEqual({});
    expect(cellLook(format, 0, null, range, null)).toEqual({});
  });

  it("can colour a cell from a field holding colours", () => {
    const byField = parseChartFormat({ conditional: [{ value: 0, apply: "background", by: "field", field: "category" }] })!;
    expect(cellLook(byField, 0, "5", range, "#00aa00").background).toBe("#00aa00");
    expect(cellLook(byField, 0, "5", range, "Otago")).toEqual({});
  });
});

describe("table totals and pivot subtotals", () => {
  const columns: ResultColumn[] = [
    { key: "category", label: "Region", format: "text", role: "category" },
    { key: "m0", label: "Sales", format: "money", role: "measure" },
    { key: "m1", label: "Average sale", format: "money", role: "measure" },
  ];
  it("adds up additive values exactly, and leaves averages and the like blank", () => {
    const totals = tableTotals(columns, [{ m0: "0.10", m1: "5" }, { m0: "0.20", m1: "7" }, { m0: null, m1: null }], ["sum", "avg"]);
    expect(totals).toEqual({ category: null, m0: "0.30", m1: null });
  });

  it("hides chosen subtotal levels, keeping the grand total", () => {
    const rows: PivotRow[] = [
      { key: "a", kind: "detail", depth: 2, dimensions: ["A", "x"], cells: {} },
      { key: "b", kind: "subtotal", depth: 1, dimensions: ["A", null], cells: {} },
      { key: "c", kind: "grand_total", depth: 0, dimensions: [null, null], cells: {} },
    ];
    expect(visiblePivotRows(rows, undefined).map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(visiblePivotRows(rows, { subtotalsOff: [1] }).map((row) => row.key)).toEqual(["a", "c"]);
    expect(visiblePivotRows(rows, { totals: false }).map((row) => row.key)).toEqual(["a", "b"]);
  });
});

describe("chart colours by rule", () => {
  it("colours the columns that match, e.g. red below target", () => {
    const spec: ChartSpec = { kind: "column", category: "month", series: [{ field: "sales", label: "Sales", kind: "money" }], valueFormat: "money", format: { chartRules: [{ op: "<", value: "150", color: "#ba3e3c" }] } };
    const theme = { text: "#1b2533", mutedText: "#546072", grid: "#e9edf2", background: "#ffffff", palette: ["#1f5fae", "#d66919"] };
    const option = toEChartsOption(spec, [{ month: "A", sales: "100" }, { month: "B", sales: "200" }], theme) as unknown as { series: Array<{ data: unknown[] }> };
    expect(option.series[0].data[0]).toMatchObject({ value: 100, itemStyle: { color: "#ba3e3c" } });
    expect(option.series[0].data[1]).toBe(200);
  });
});
