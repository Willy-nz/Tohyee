import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { CHATHAM_SHIFT, DISTRICT_NAMES, MAP_IDS, REGION_NAMES, areaKey, areaTotals, chooseAreas, mapNote, mapPoint, mapPoints, matchArea } from "@/lib/analytics/maps";
import { CHART_TOKENS, chartThemeFromTokens } from "@/lib/charts/theme";

const theme: ChartTheme = chartThemeFromTokens(CHART_TOKENS.light);

type AnyOption = Record<string, unknown> & { series: Array<Record<string, unknown>> };
function option(spec: ChartSpec, rows: Array<Record<string, string | number | null>>): AnyOption {
  const result = toEChartsOption(spec, rows, theme);
  expect("series" in result).toBe(true);
  return result as unknown as AnyOption;
}

type Feature = { properties: { name: string }; geometry: { type: string; coordinates: unknown } };
const boundaries = (file: string): Feature[] => (JSON.parse(readFileSync(`src/lib/analytics/maps/${file}.json`, "utf8")) as { features: Feature[] }).features;

describe("New Zealand boundaries", () => {
  it("ship the 16 regions and the Chatham Islands, and the 67 territorial authorities, named as the matcher expects", () => {
    expect(boundaries("nz-regions").map((feature) => feature.properties.name)).toEqual(REGION_NAMES);
    expect(boundaries("nz-districts").map((feature) => feature.properties.name)).toEqual(DISTRICT_NAMES);
    expect(REGION_NAMES).toHaveLength(17);
    expect(DISTRICT_NAMES).toHaveLength(67);
    // No two areas tidy to the same name.
    expect(new Set(REGION_NAMES.map(areaKey)).size).toBe(17);
    expect(new Set(DISTRICT_NAMES.map(areaKey)).size).toBe(67);
  });

  it("stay small and inside New Zealand (no 180° wrap, the Chathams drawn close in)", () => {
    for (const file of ["nz-regions", "nz-districts"]) {
      expect(readFileSync(`src/lib/analytics/maps/${file}.json`).length).toBeLessThan(100_000);
      const points: number[][] = [];
      const walk = (value: unknown) => (Array.isArray(value) && typeof value[0] === "number" ? points.push(value as number[]) : Array.isArray(value) && value.forEach(walk));
      boundaries(file).forEach((feature) => walk(feature.geometry.coordinates));
      expect(Math.min(...points.map((point) => point[0]))).toBeGreaterThan(166);
      expect(Math.max(...points.map((point) => point[0]))).toBeLessThan(179);
      expect(Math.min(...points.map((point) => point[1]))).toBeGreaterThan(-48);
      expect(Math.max(...points.map((point) => point[1]))).toBeLessThan(-34);
    }
  });
});

describe("matching names to areas", () => {
  it("ignores macrons, case, apostrophes and words like Region or District", () => {
    expect(matchArea("Manawatu-Wanganui Region", "regions")).toBe("Manawatū-Whanganui");
    expect(matchArea("hawkes bay regional council", "regions")).toBe("Hawke's Bay");
    expect(matchArea("Hawke’s Bay", "regions")).toBe("Hawke's Bay");
    expect(matchArea("WAIKATO", "regions")).toBe("Waikato");
    expect(matchArea("Taupō", "districts")).toBe("Taupo District");
    expect(matchArea("Opotiki", "districts")).toBe("Ōpōtiki District");
    expect(matchArea("Wellington", "districts")).toBe("Wellington City");
    expect(matchArea("Hutt City", "districts")).toBe("Lower Hutt City");
    expect(matchArea("Central Hawke's Bay", "regions")).toBeNull();
    expect(matchArea("Sydney", "regions")).toBeNull();
  });

  it("works out regions or districts from the names unless chosen", () => {
    expect(chooseAreas(["Waikato", "Otago", "Canterbury"])).toBe("regions");
    expect(chooseAreas(["Hamilton City", "Selwyn District", "Waikato"])).toBe("districts");
    // A tie (Waikato is both) goes to regions.
    expect(chooseAreas(["Waikato"])).toBe("regions");
    expect(chooseAreas(["Waikato", "Otago"], "districts")).toBe("districts");
  });

  it("adds groups that name the same area exactly, and lists the ones that aren't areas", () => {
    expect(areaTotals(["Wellington", "Wellington Region", "Otago", "Mars", "Mars", "Canterbury"], ["0.10", "0.20", "5", "1", "2", null], "regions")).toEqual({
      totals: [
        { name: "Wellington", value: "0.3" },
        { name: "Otago", value: "5" },
      ],
      unmatched: ["Mars"],
    });
    expect(mapNote("filledmap", [{ category: "Mars", m0: "1" }, { category: "Otago", m0: "2" }], ["Mars", "Otago"], ["m0"])).toBe("Not on the map (not New Zealand regions): Mars.");
    expect(mapNote("filledmap", [{ category: "Otago", m0: "2" }], ["Otago"], ["m0"])).toBeNull();
  });
});

describe("points by latitude and longitude", () => {
  it("places New Zealand points, moves the Chathams in, and leaves out the rest", () => {
    expect(mapPoint(-41.29, 174.78)).toEqual([174.78, -41.29]);
    expect(mapPoint(-43.95, -176.56)).toEqual([183.44 + CHATHAM_SHIFT, -43.95]);
    expect(mapPoint(-33.87, 151.21)).toBeNull();
    expect(mapPoint(41.29, 174.78)).toBeNull();
    expect(mapPoint(null, 174.78)).toBeNull();
    const rows = [
      { category: "Home farm", m0: "-37.78", m1: "175.28", m2: "120" },
      { category: "Sydney office", m0: "-33.87", m1: "151.21", m2: "5" },
      { category: "No address", m0: null, m1: null, m2: "1" },
    ];
    const { points, outside } = mapPoints(rows, ["m0", "m1", "m2"]);
    expect(points).toEqual([{ row: 0, at: [175.28, -37.78], size: 120 }]);
    expect(outside).toBe(2);
    expect(mapNote("pointmap", rows, rows.map((row) => row.category), ["m0", "m1"])).toBe("2 points aren't on the map: no latitude and longitude, or not in New Zealand.");
  });
});

describe("map charts", () => {
  it("draws a filled map on the chosen boundaries with the theme's scale, no outside tiles", () => {
    const spec: ChartSpec = { kind: "filledmap", category: "category", series: [{ field: "m0", label: "Sales" }], valueFormat: "money" };
    const rows = [
      { category: "Waikato", m0: "100.10" },
      { category: "Waikato Region", m0: "0.20" },
      { category: "Otago", m0: "50" },
    ];
    const result = option(spec, rows) as AnyOption & { visualMap: { inRange: { color: string[] }; seriesIndex: number } };
    const series = result.series[0] as { type: string; map: string; roam: boolean; data: Array<{ name: string; value: number; exact: string }> };
    expect(series.type).toBe("map");
    expect(series.map).toBe(MAP_IDS.regions);
    expect(series.roam).toBe(false);
    expect(series.data).toEqual([
      { name: "Waikato", value: 100.3, exact: "100.3" },
      { name: "Otago", value: 50, exact: "50" },
    ]);
    expect(result.visualMap.inRange.color).toEqual(CHART_TOKENS.light.sequential);
    // Chosen areas win over working it out.
    const districts = option({ ...spec, format: { map: { areas: "districts" } } }, [{ category: "Hamilton", m0: "1" }]).series[0] as { map: string; data: Array<{ name: string }> };
    expect(districts.map).toBe(MAP_IDS.districts);
    expect(districts.data.map((entry) => entry.name)).toEqual(["Hamilton City"]);
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });

  it("draws points on the regions, sized by a third value, in the first value's colour", () => {
    const spec: ChartSpec = { kind: "pointmap", category: "category", series: [{ field: "m0", label: "Latitude" }, { field: "m1", label: "Longitude" }, { field: "m2", label: "Cows" }], valueFormat: "number" };
    const rows = [
      { category: "Home farm", m0: "-37.78", m1: "175.28", m2: "400" },
      { category: "Run-off", m0: "-38.1", m1: "175.5", m2: "100" },
      { category: "Sydney", m0: "-33.87", m1: "151.21", m2: "5" },
    ];
    const result = option(spec, rows) as AnyOption & { geo: { map: string; roam: boolean } };
    expect(result.geo.map).toBe(MAP_IDS.regions);
    expect(result.geo.roam).toBe(false);
    const series = result.series[0] as { type: string; coordinateSystem: string; data: Array<{ value: number[]; name: string; symbolSize: number }>; itemStyle: { color: string } };
    expect(series.type).toBe("scatter");
    expect(series.coordinateSystem).toBe("geo");
    expect(series.data.map((point) => [point.name, point.value])).toEqual([["Home farm", [175.28, -37.78]], ["Run-off", [175.5, -38.1]]]);
    expect(series.data[0].symbolSize).toBeGreaterThan(series.data[1].symbolSize);
    expect(series.itemStyle.color).toBe(theme.palette[0]);
  });

  it("checks the map setting like every other format setting", () => {
    expect(parseChartFormat({ map: { areas: "districts" } })).toEqual({ map: { areas: "districts" } });
    expect(parseChartFormat({ map: { areas: "" } })).toBeUndefined();
    expect(() => parseChartFormat({ map: { areas: "suburbs" } })).toThrow(/Map areas/);
  });
});
