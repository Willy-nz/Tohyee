import { describe, expect, it } from "vitest";
import { mergeFormats, painterFormat, parseVisualDefaults, pasteFormat, type ChartFormat } from "@/lib/analytics/chart-format";
import { parseThemeChoice } from "@/lib/charts/report-themes";
import { tileWithDefaults } from "@/lib/analytics/tile-chart";

describe("chart type defaults in a report (Power BI's visual defaults)", () => {
  it("keeps only known chart types and checks each format like a tile's", () => {
    expect(parseVisualDefaults(undefined)).toBeUndefined();
    expect(parseVisualDefaults({})).toBeUndefined();
    expect(parseVisualDefaults({ column: { labels: { show: true }, mystery: 1 }, spaceship: { smooth: true } })).toEqual({ column: { labels: { show: true } } });
    expect(() => parseVisualDefaults({ line: { legend: { position: "upside" } } })).toThrow(/Line/);
    expect(() => parseVisualDefaults([])).toThrow();
  });

  it("never keeps a key figure's target as a default (it's data, not format)", () => {
    expect(parseVisualDefaults({ kpi: { kpi: { target: "100", downIsGood: true } } })).toEqual({ kpi: { kpi: { downIsGood: true } } });
  });

  it("lets a tile's own settings win over the report's default, setting by setting", () => {
    const base: ChartFormat = { labels: { show: true, position: "inside" }, legend: { position: "bottom" }, series: [{ color: "orange" }, { color: "green" }], smooth: true };
    const own: ChartFormat = { labels: { position: "outside" }, series: [{ number: { decimals: 0 } }], smooth: false };
    expect(mergeFormats(base, own)).toEqual({
      labels: { show: true, position: "outside" },
      legend: { position: "bottom" },
      series: [{ color: "orange", number: { decimals: 0 } }, { color: "green" }],
      smooth: false,
    });
    expect(mergeFormats(undefined, own)).toEqual(own);
    expect(mergeFormats(base, undefined)).toEqual(base);
    expect(mergeFormats(undefined, undefined)).toBeUndefined();
  });

  it("draws a tile with its report's default for its chart type, and leaves others alone", () => {
    const tile = { id: "a", visual: "column", format: { smooth: true } as ChartFormat };
    expect(tileWithDefaults(tile, undefined)).toBe(tile);
    expect(tileWithDefaults(tile, { line: { markers: false } })).toBe(tile);
    expect(tileWithDefaults(tile, { column: { labels: { show: true } } }).format).toEqual({ labels: { show: true }, smooth: true });
    expect(tileWithDefaults({ visual: "text" }, { column: { smooth: true } })).toEqual({ visual: "text" });
  });

  it("copies a tile's format for pasting without its target", () => {
    const format: ChartFormat = { palette: "warm", kpi: { target: "500", change: "percent" } };
    expect(painterFormat(format)).toEqual({ palette: "warm", kpi: { change: "percent" } });
    expect(painterFormat({ kpi: { target: "1" } })).toBeUndefined();
    expect(painterFormat(undefined)).toBeUndefined();
  });

  it("pastes a copied format over a tile's own, keeping that tile's target", () => {
    expect(pasteFormat({ palette: "warm", kpi: { target: "1", downIsGood: true } }, { smooth: true, kpi: { target: "250" } })).toEqual({ palette: "warm", kpi: { downIsGood: true, target: "250" } });
    expect(pasteFormat({ legend: { show: "hide" } }, { smooth: true })).toEqual({ legend: { show: "hide" } });
    // Pasting "no format" resets the tile, still keeping its target.
    expect(pasteFormat(undefined, { smooth: true })).toBeUndefined();
    expect(pasteFormat(undefined, { kpi: { target: "9" } })).toEqual({ kpi: { target: "9" } });
  });
});

describe("a report's theme choice", () => {
  it("is a built-in theme or one of the organisation's; Tohyee is left out", () => {
    expect(parseThemeChoice(undefined)).toBeNull();
    expect(parseThemeChoice("tohyee")).toBeNull();
    expect(parseThemeChoice("harbour")).toBe("harbour");
    expect(parseThemeChoice("custom:4")).toBe("custom:4");
    expect(() => parseThemeChoice("custom:abc")).toThrow(/theme/);
    expect(() => parseThemeChoice("neon")).toThrow(/theme/);
  });
});
