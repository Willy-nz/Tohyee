import { describe, expect, it } from "vitest";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import { mergeFormats, pasteFormat } from "@/lib/analytics/chart-format";
import type { Tile } from "@/lib/analytics/dashboards";
import { isSpecialistVisual, settingSource, sourceText, usesAdvanced, valueAt, withoutSettings } from "@/lib/analytics/editor-panels";
import { alignRowHeights, evenWidth, layoutRows, matchSize, shareRow } from "@/lib/analytics/layout";

describe("where a chart's setting comes from (#387, decision 750)", () => {
  const chartDefault: ChartFormat = { legend: { position: "bottom" }, series: [{ number: { decimals: 0 } }] };
  const own: ChartFormat = { series: [{ number: { style: "currency", compact: true } }], card: { subtitle: "Excl. GST" } };

  it("names the chart's own override, the chart type default or the theme", () => {
    expect(settingSource(["series", 0, "number"], own, chartDefault)).toBe("chart");
    expect(settingSource(["legend"], own, chartDefault)).toBe("default");
    expect(settingSource(["valueAxis"], own, chartDefault)).toBe("theme");
    // A group of settings counts as changed if any one is.
    expect(settingSource([["gridlines"], ["card"]], own, chartDefault)).toBe("chart");
    // Empty leftovers don't count as a change.
    expect(settingSource(["labels"], { labels: {} }, undefined)).toBe("theme");
    expect(sourceText("chart", "Columns", "Tohyee")).toBe("Changed on this chart");
    expect(sourceText("default", "Columns", "Tohyee")).toBe("From this report's columns default");
    expect(sourceText("theme", "Columns", "Harbour")).toBe("From the Harbour theme");
  });

  it("resets one override and leaves every other setting alone", () => {
    const format: ChartFormat = {
      palette: "warm",
      series: [{ number: { style: "currency" }, color: "orange" }, { number: { decimals: 1 } }],
      legend: { position: "right" },
    };
    expect(withoutSettings(format, ["series", 0, "number"])).toEqual({
      palette: "warm",
      series: [{ color: "orange" }, { number: { decimals: 1 } }],
      legend: { position: "right" },
    });
    // The last setting of a value goes, and nothing empty is left behind.
    expect(withoutSettings({ series: [{ number: { style: "plain" } }] }, ["series", 0, "number"])).toBeUndefined();
    expect(withoutSettings({ series: [{ color: "red" }, { number: { style: "plain" } }] }, ["series", 1, "number"])).toEqual({ series: [{ color: "red" }] });
    expect(withoutSettings(format, [["legend"], ["palette"]])).toEqual({ series: format.series });
    // The original isn't changed.
    expect(format.series?.[0].number).toEqual({ style: "currency" });
    expect(withoutSettings(undefined, ["legend"])).toBeUndefined();
    expect(valueAt(format, ["series", 1, "number", "decimals"])).toBe(1);
  });

  it("acceptance: a monthly sales chart's number format, copied and then reset on its own", () => {
    // Make the chart and change its number format.
    const sales: ChartFormat = { series: [{ number: { style: "currency", compact: true } }], legend: { position: "bottom" } };
    // Copy its style to another chart (the format painter).
    const other = pasteFormat(sales, undefined);
    expect(other).toEqual(sales);
    // Reset only the number format: the legend stays, and the copy is untouched.
    const reset = withoutSettings(sales, ["series", 0, "number"]);
    expect(reset).toEqual({ legend: { position: "bottom" } });
    expect(other?.series?.[0].number).toEqual({ style: "currency", compact: true });
    // With a chart type default, the reset setting now comes from it.
    const chartDefault: ChartFormat = { series: [{ number: { decimals: 0 } }] };
    expect(settingSource(["series", 0, "number"], reset, chartDefault)).toBe("default");
    expect(mergeFormats(chartDefault, reset)).toEqual({ series: [{ number: { decimals: 0 } }], legend: { position: "bottom" } });
  });

  it("keeps specialist chart types and advanced settings out of the way until they're used", () => {
    expect(isSpecialistVisual("column")).toBe(false);
    expect(isSpecialistVisual("kpi")).toBe(false);
    expect(isSpecialistVisual("sankey")).toBe(true);
    expect(isSpecialistVisual("boxplot")).toBe(true);
    expect(usesAdvanced({ legend: { position: "top-left" } })).toBe(false);
    expect(usesAdvanced({ referenceLines: [{ kind: "average" }] })).toBe(true);
    expect(usesAdvanced({ valueAxis: { log: true } })).toBe(true);
    expect(usesAdvanced({ valueAxis: { title: "Sales" } })).toBe(false);
    expect(usesAdvanced({ series: [{}, { trend: true }] })).toBe(true);
  });
});

const tile = (id: string, width: Tile["width"], height?: Tile["height"]): Tile => ({ id, title: id.toUpperCase(), visual: "text", width, query: null, ...(height ? { height } : {}) });

describe("aligning and sizing tiles in the grid (#387, decision 752)", () => {
  it("works out the rows as the grid lays them out", () => {
    expect(layoutRows([tile("a", "half"), tile("b", "third"), tile("c", "quarter"), tile("d", "full"), tile("e", "two-thirds"), tile("f", "half")])).toEqual([[0, 1], [2], [3], [4], [5]]);
    expect(layoutRows([tile("a", "quarter"), tile("b", "quarter"), tile("c", "half")])).toEqual([[0, 1, 2]]);
    expect(evenWidth(3)).toBe("third");
    expect(evenWidth(5)).toBeNull();
  });

  it("gives tiles the first chosen tile's width or height", () => {
    const tiles = [tile("a", "third", "large"), tile("b", "half"), tile("c", "full", "small")];
    const widths = matchSize(tiles, ["a", "c"], "width");
    expect("tiles" in widths && widths.tiles.map((entry) => entry.width)).toEqual(["third", "half", "third"]);
    const heights = matchSize(tiles, ["b", "c"], "height");
    expect("tiles" in heights && heights.tiles.map((entry) => entry.height)).toEqual(["large", undefined, undefined]);
    expect(matchSize(tiles, ["a"], "width")).toEqual({ error: "Choose two or more tiles." });
  });

  it("shares a row evenly, moving the chosen tiles together and lining up their heights", () => {
    const tiles = [tile("a", "full"), tile("b", "half"), tile("c", "full"), tile("d", "quarter", "large")];
    const result = shareRow(tiles, ["d", "b"]);
    if (!("tiles" in result)) throw new Error(result.error);
    expect(result.tiles.map((entry) => [entry.id, entry.width, entry.height ?? "medium"])).toEqual([
      ["a", "full", "medium"],
      ["b", "half", "large"],
      ["d", "half", "large"],
      ["c", "full", "medium"],
    ]);
    expect(layoutRows(result.tiles)).toEqual([[0], [1, 2], [3]]);
    // The same tile chosen twice counts once.
    expect("tiles" in shareRow(tiles, ["a", "b", "c", "d", "a"])).toBe(true);
    expect(shareRow([...tiles, tile("e", "half")], ["a", "b", "c", "d", "e"])).toEqual({ error: "A row can be shared by up to four tiles." });
  });

  it("lines up the bottoms of a row", () => {
    const tiles = [tile("a", "half", "small"), tile("b", "half", "large"), tile("c", "full", "small")];
    const result = alignRowHeights(tiles, ["a"]);
    if (!("tiles" in result)) throw new Error(result.error);
    expect(result.tiles.map((entry) => entry.height)).toEqual(["large", "large", "small"]);
    expect(result.message).toBe("1 tile is now as tall as the rest of its row.");
  });
});
