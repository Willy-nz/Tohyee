import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";

const theme: ChartTheme = { text: "#15201c", mutedText: "#57635e", grid: "#e1e6e3", background: "#ffffff", palette: ["#0e7467", "#b45309"] };
const rows = [
  { month: "2026-01-01", sales: "1" },
  { month: "2026-02-01", sales: "2" },
];

describe("zooming a time chart (#376 phase 3, decision 760)", () => {
  it("adds a slider and wheel zoom on the group axis, with room for the slider", () => {
    const spec: ChartSpec = { kind: "line", category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "number", format: { zoom: true } };
    const option = toEChartsOption(spec, rows, theme) as { dataZoom?: Array<{ type: string; xAxisIndex: number }>; grid?: { bottom: number } };
    expect(option.dataZoom?.map((entry) => [entry.type, entry.xAxisIndex])).toEqual([
      ["inside", 0],
      ["slider", 0],
    ]);
    const plain = toEChartsOption({ ...spec, format: {} }, rows, theme) as { dataZoom?: unknown; grid?: { bottom: number } };
    expect(plain.dataZoom).toBeUndefined();
    expect(option.grid!.bottom).toBeGreaterThan(plain.grid!.bottom ?? 0);
  });

  it("isn't added to bar charts, and is saved like other settings", () => {
    const option = toEChartsOption({ kind: "bar", category: "month", series: [{ field: "sales", label: "Sales" }], valueFormat: "number", format: { zoom: true } }, rows, theme) as { dataZoom?: unknown };
    expect(option.dataZoom).toBeUndefined();
    expect(parseChartFormat({ zoom: true })).toEqual({ zoom: true });
    expect(parseChartFormat({ zoom: false })).toEqual({ zoom: false });
  });
});
