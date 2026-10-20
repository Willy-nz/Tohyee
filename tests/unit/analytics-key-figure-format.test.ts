import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { figureColour, figureStyle, keyFigure, keyFigureNumbers, sparkPoints } from "@/lib/analytics/key-figure";
import type { QueryResult } from "@/lib/analytics/query";

/** Key figure formatting (#376 phase 1, part 3). */

const money = (key: string, label: string) => ({ key, label, format: "money" as const, role: "measure" as const });
const sales = (value: string | null): QueryResult => ({ columns: [money("m0", "Sales")], rows: [{ m0: value }], truncated: false });

describe("checking key figure settings", () => {
  it("keeps known settings and refuses wrong ones", () => {
    const parsed = parseChartFormat({
      kpi: {
        target: "500",
        size: "xl",
        sizePx: 64,
        color: "#AA0000",
        align: "center",
        label: "below",
        bold: false,
        colorBy: "rules",
        rules: [{ op: ">=", value: "1000", color: "#057836", mystery: 1 }, { op: "<", value: "0", color: "#ba3e3c" }],
        icon: "arrow",
        sparkline: "column",
        sparkColor: "#123456",
        multi: true,
        extra: "dropped",
      },
    });
    expect(parsed).toEqual({
      kpi: {
        target: "500",
        size: "xl",
        sizePx: 64,
        color: "#aa0000",
        align: "center",
        label: "below",
        bold: false,
        colorBy: "rules",
        rules: [{ op: ">=", value: "1000", color: "#057836" }, { op: "<", value: "0", color: "#ba3e3c" }],
        icon: "arrow",
        sparkline: "column",
        sparkColor: "#123456",
        multi: true,
      },
    });
    expect(() => parseChartFormat({ kpi: { size: "huge" } })).toThrow(/Number size/);
    expect(() => parseChartFormat({ kpi: { sizePx: 200 } })).toThrow(/16 to 96/);
    expect(() => parseChartFormat({ kpi: { rules: [{ op: "~", value: "1", color: "#000000" }] } })).toThrow(/Colour rule 1/);
    expect(() => parseChartFormat({ kpi: { rules: [{ op: ">", value: "lots", color: "#000000" }] } })).toThrow(/number/);
    expect(() => parseChartFormat({ kpi: { rules: [{ op: ">", value: "1" }] } })).toThrow(/colour/);
    expect(() => parseChartFormat({ kpi: { rules: Array(7).fill({ op: ">", value: "1", color: "#000000" }) } })).toThrow(/up to 6/);
    expect(() => parseChartFormat({ kpi: { sparkline: "pie" } })).toThrow(/Trend/);
  });

  it("leaves an old key figure's format as it was", () => {
    expect(parseChartFormat({ kpi: { target: "5000", downIsGood: true, change: "percent" } })).toEqual({ kpi: { target: "5000", downIsGood: true, change: "percent" } });
  });
});

describe("the number's colour", () => {
  it("follows the first rule that matches, compared exactly", () => {
    const rules = { kpi: { colorBy: "rules" as const, rules: [{ op: ">=" as const, value: "1000.00", color: "#057836" }, { op: "<" as const, value: "0", color: "#ba3e3c" }] } };
    expect(figureColour(keyFigure(sales("1000"), rules)!, rules)).toBe("#057836");
    // 999.999 is under 1000 exactly (no rounding).
    expect(figureColour(keyFigure(sales("999.999"), rules)!, rules)).toBeNull();
    expect(figureColour(keyFigure(sales("-0.01"), rules)!, rules)).toBe("#ba3e3c");
    expect(figureColour(keyFigure(sales(null), rules)!, rules)).toBeNull();
    const equal = { kpi: { colorBy: "rules" as const, rules: [{ op: "=" as const, value: "5", color: "#000001" }] } };
    expect(figureColour(keyFigure(sales("5.00"), equal)!, equal)).toBe("#000001");
  });

  it("can be green or red by the comparison (good news or not), or a fixed colour", () => {
    const vsTarget = { kpi: { target: "500", colorBy: "change" as const } };
    expect(figureColour(keyFigure(sales("600"), vsTarget)!, vsTarget)).toBe("good");
    expect(figureColour(keyFigure(sales("400"), vsTarget)!, vsTarget)).toBe("bad");
    const costs = { kpi: { target: "500", colorBy: "change" as const, downIsGood: true } };
    expect(figureColour(keyFigure(sales("400"), costs)!, costs)).toBe("good");
    const fixed = { kpi: { color: "#123456" } };
    expect(figureColour(keyFigure(sales("1"), fixed)!, fixed)).toBe("#123456");
    expect(figureColour(keyFigure(sales("1"))!, undefined)).toBeNull();
  });
});

describe("the number's style", () => {
  it("has sizes, a custom size, alignment and weight", () => {
    expect(figureStyle(undefined)).toEqual({});
    expect(figureStyle({ kpi: { size: "s" } }).fontSize).toBe("min(22px, 14cqi)");
    expect(figureStyle({ kpi: { size: "xl" } }).fontSize).toBe("min(56px, 14cqi)");
    expect(figureStyle({ kpi: { size: "xl", sizePx: 40 } }).fontSize).toBe("min(40px, 14cqi)");
    expect(figureStyle({ kpi: { align: "right", bold: false } })).toEqual({ textAlign: "right", justifyItems: "end", fontWeight: 500 });
  });
});

describe("several numbers in one card (Power BI's multi-row card)", () => {
  it("lists every value with its own label, comparisons kept with the first", () => {
    const result: QueryResult = {
      columns: [money("m0", "Sales"), money("m0_pp", "Sales previous period"), money("m1", "Costs"), { key: "m2", label: "Orders", format: "number", role: "measure" }],
      rows: [{ m0: "10", m0_pp: "8", m1: "4", m2: "3" }],
      truncated: false,
    };
    expect(keyFigureNumbers(result).map((entry) => [entry.column.label, entry.value])).toEqual([
      ["Sales", "10"],
      ["Costs", "4"],
      ["Orders", "3"],
    ]);
  });
});

describe("the trend underneath", () => {
  it("draws as a line, an area or columns, from display numbers", () => {
    const trend = [{ month: "2026-01-01", value: "10" }, { month: "2026-02-01", value: null }, { month: "2026-03-01", value: "30" }];
    const points = sparkPoints(trend, 160, 40);
    expect(points).toHaveLength(3);
    expect(points[1].y).toBeNull();
    expect(points[0].x).toBeLessThan(points[2].x);
    expect(points[0].y!).toBeGreaterThan(points[2].y!);
    expect(sparkPoints([{ month: "2026-01-01", value: "5" }], 160, 40)).toEqual([]);
  });
});
