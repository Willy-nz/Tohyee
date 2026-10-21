import type { EChartsOption } from "echarts";
import type { ChartKit } from "@/lib/analytics/chart-visuals";
import { bubbleSizes } from "@/lib/analytics/chart-distributions";
import { visualMap } from "@/lib/analytics/chart-relationships";
import { MARKS, tooltipHtml, type TooltipRow } from "@/lib/charts/theme";
import { add, dec, isDecimalString, toPlainString, type Decimal } from "@/lib/money/decimal";

/**
 * New Zealand maps (#376 phase 2, decision 687): a filled map of regions or
 * territorial authorities, and points by latitude and longitude. Drawn from
 * boundary files that ship with Tohyee (Stats NZ boundaries, CC BY 4.0, in
 * `src/lib/analytics/maps/`), never from an outside map or tile service.
 * Shared with the browser; the boundary files themselves are loaded only
 * when a map is drawn.
 */

export type MapAreas = "regions" | "districts";

/** Shown under every map: the boundaries' licence (CC BY 4.0) asks for it. */
export const MAP_ATTRIBUTION = "Boundaries: Stats NZ, CC BY 4.0.";

/** The ECharts map names the boundary files are registered under. */
export const MAP_IDS: Record<MapAreas, string> = { regions: "tohyee-nz-regions", districts: "tohyee-nz-districts" };

/** The 16 regions and the Chatham Islands, as named in the boundary file. */
export const REGION_NAMES = ["Auckland", "Bay of Plenty", "Canterbury", "Chatham Islands", "Gisborne", "Hawke's Bay", "Manawatū-Whanganui", "Marlborough", "Nelson", "Northland", "Otago", "Southland", "Taranaki", "Tasman", "Waikato", "Wellington", "West Coast"];

/** The 67 territorial authorities (districts and cities, Auckland as one), as named in the boundary file (Stats NZ 2021). */
export const DISTRICT_NAMES = [
  "Ashburton District", "Auckland", "Buller District", "Carterton District", "Central Hawke's Bay District", "Central Otago District", "Chatham Islands", "Christchurch City",
  "Clutha District", "Dunedin City", "Far North District", "Gisborne District", "Gore District", "Grey District", "Hamilton City", "Hastings District", "Hauraki District",
  "Horowhenua District", "Hurunui District", "Invercargill City", "Kaikoura District", "Kaipara District", "Kapiti Coast District", "Kawerau District", "Lower Hutt City",
  "Mackenzie District", "Manawatu District", "Marlborough District", "Masterton District", "Matamata-Piako District", "Napier City", "Nelson City", "New Plymouth District",
  "Palmerston North City", "Porirua City", "Queenstown-Lakes District", "Rangitikei District", "Rotorua District", "Ruapehu District", "Selwyn District", "South Taranaki District",
  "South Waikato District", "South Wairarapa District", "Southland District", "Stratford District", "Tararua District", "Tasman District", "Taupo District", "Tauranga City",
  "Thames-Coromandel District", "Timaru District", "Upper Hutt City", "Waikato District", "Waimakariri District", "Waimate District", "Waipa District", "Wairoa District",
  "Waitaki District", "Waitomo District", "Wellington City", "Western Bay of Plenty District", "Westland District", "Whakatane District", "Whanganui District", "Whangarei District",
  "Ōpōtiki District", "Ōtorohanga District",
];

/** Other names people use for an area, after `areaKey` has tidied them. */
const ALIASES: Record<string, string> = {
  wanganui: "whanganui",
  "manawatu wanganui": "manawatu whanganui",
  "horizons": "manawatu whanganui",
  tairawhiti: "gisborne",
  "te tai tokerau": "northland",
  "hutt": "lower hutt",
  queenstown: "queenstown lakes",
  coromandel: "thames coromandel",
  "chatham islands territory": "chatham islands",
  chathams: "chatham islands",
  "nelson tasman": "nelson",
  "otago region": "otago",
};

/**
 * An area's name tidied for matching: no macrons, case, apostrophes or
 * punctuation, and without "Region", "District", "City" or "Council" at the
 * end, so "Hawke's Bay Regional Council", "hawkes bay" and "Hawke’s Bay"
 * all match.
 */
export function areaKey(name: string): string {
  const text = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+(regional council|district council|city council|council|region|district|city|territory|territorial authority)$/, "")
    .trim();
  return ALIASES[text] ?? text;
}

const LOOKUP: Record<MapAreas, Map<string, string>> = {
  regions: new Map(REGION_NAMES.map((name) => [areaKey(name), name])),
  districts: new Map(DISTRICT_NAMES.map((name) => [areaKey(name), name])),
};

/** The boundary's name for a group's name, or null when it isn't one of them. */
export function matchArea(name: string, areas: MapAreas): string | null {
  return LOOKUP[areas].get(areaKey(name)) ?? null;
}

/** Regions or territorial authorities: as chosen, otherwise whichever more of the group names match (regions on a tie). */
export function chooseAreas(names: string[], chosen?: MapAreas): MapAreas {
  if (chosen) return chosen;
  const count = (areas: MapAreas) => names.filter((name) => matchArea(name, areas) !== null).length;
  return count("districts") > count("regions") ? "districts" : "regions";
}

function exact(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return isDecimalString(text) ? dec(text) : null;
}

/**
 * Each area's total from the groups that name it (added exactly, so
 * "Wellington" and "Wellington Region" make one total), and the group names
 * that aren't an area, in order, once each.
 */
export function areaTotals(names: string[], values: Array<string | number | null>, areas: MapAreas): { totals: Array<{ name: string; value: string }>; unmatched: string[] } {
  const totals = new Map<string, Decimal>();
  const unmatched: string[] = [];
  names.forEach((name, index) => {
    const area = matchArea(name, areas);
    if (!area) {
      if (name && !unmatched.includes(name)) unmatched.push(name);
      return;
    }
    const value = exact(values[index]);
    if (value === null) return;
    totals.set(area, add(totals.get(area) ?? dec("0"), value));
  });
  return { totals: [...totals.entries()].map(([name, total]) => ({ name, value: toPlainString(total) })), unmatched };
}

/** The Chatham Islands are drawn this many degrees closer to the mainland (an inset, as on Stats NZ's maps); points there move with them. */
export const CHATHAM_SHIFT = -6.5;

/**
 * Where a latitude and longitude go on the map, or null when they aren't in
 * New Zealand (the main islands, Stewart Island and the Chatham Islands).
 * Longitudes west of 180° are taken the long way round (-176.5 is 183.5).
 */
export function mapPoint(latitude: number | null, longitude: number | null): [number, number] | null {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const east = longitude < 0 ? longitude + 360 : longitude;
  if (latitude >= -44.7 && latitude <= -43.3 && east >= 182.5 && east <= 184.5) return [east + CHATHAM_SHIFT, latitude];
  if (latitude >= -47.6 && latitude <= -34 && east >= 166 && east <= 179) return [east, latitude];
  return null;
}

function rowNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The points a map with points draws (first value latitude, second longitude, a third sizes them), and how many were left out. */
export function mapPoints(rows: Array<Record<string, string | number | null>>, fields: string[]): { points: Array<{ row: number; at: [number, number]; size: number | null }>; outside: number } {
  let outside = 0;
  const points = rows.flatMap((row, index) => {
    const at = mapPoint(rowNumber(row[fields[0]]), rowNumber(row[fields[1]]));
    if (!at) {
      outside += 1;
      return [];
    }
    return [{ row: index, at, size: fields[2] ? rowNumber(row[fields[2]]) : null }];
  });
  return { points, outside };
}

const AREA_LABELS: Record<MapAreas, string> = { regions: "regions", districts: "districts and cities" };

/** A sentence for under a map about groups that couldn't be placed, or null. */
export function mapNote(kind: "filledmap" | "pointmap", rows: Array<Record<string, string | number | null>>, names: string[], fields: string[], chosen?: MapAreas): string | null {
  if (kind === "filledmap") {
    const areas = chooseAreas(names, chosen);
    const { unmatched } = areaTotals(names, rows.map((row) => row[fields[0]] ?? null), areas);
    if (!unmatched.length) return null;
    const shown = unmatched.slice(0, 3).join(", ");
    return `Not on the map (not New Zealand ${AREA_LABELS[areas]}): ${shown}${unmatched.length > 3 ? ` and ${unmatched.length - 3} more` : ""}.`;
  }
  const { outside } = mapPoints(rows, fields);
  return outside ? `${outside} ${outside === 1 ? "point isn't" : "points aren't"} on the map: no latitude and longitude, or not in New Zealand.` : null;
}

// --------------------------------------------------------------- Filled map

/** The colour scale under a filled map, with its lowest and highest figures at the ends. */
function scale(kit: ChartKit, values: number[]) {
  const map = visualMap(kit, values, { seriesIndex: 0 });
  return { ...map, text: [kit.axisFormatters[0](map.max), kit.axisFormatters[0](map.min)], textGap: 6 };
}

export function filledMapOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const field = spec.series[0].field;
  const areas = chooseAreas(kit.categories, format.map?.areas);
  const { totals } = areaTotals(kit.categories, rows.map((row) => row[field]), areas);
  const values = totals.map((entry) => Number(entry.value));
  const labels = format.labels ?? {};
  const full = kit.fullFormatters[0];
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { name?: string; color?: string; data?: { exact?: string } };
        const shown = entry.data?.exact;
        return tooltipHtml(theme, entry.name ?? "", [{ colour: shown !== undefined && typeof entry.color === "string" ? entry.color : "transparent", name: spec.series[0].label, value: shown !== undefined ? full(shown) : "No data" }]);
      },
    },
    visualMap: (values.length ? scale(kit, values) : undefined) as EChartsOption["visualMap"],
    series: [
      {
        type: "map",
        map: MAP_IDS[areas],
        name: spec.series[0].label,
        top: kit.compact ? 4 : 8,
        bottom: values.length ? (kit.compact ? 36 : 44) : 8,
        left: "center",
        roam: false,
        selectedMode: false,
        // No dot on each area: the colour is the figure.
        showLegendSymbol: false,
        data: totals.map((entry) => ({ name: entry.name, value: Number(entry.value), exact: entry.value })),
        // Areas with no figure are the plot's grey; lines between areas in the card's colour.
        itemStyle: { areaColor: theme.grid, borderColor: theme.background, borderWidth: 0.8 },
        emphasis: { label: { show: false }, itemStyle: { areaColor: null, color: null, borderColor: theme.text, borderWidth: 1.5 } },
        label: labels.show
          ? {
              show: true,
              fontSize: kit.labelSize,
              color: labels.color ?? theme.text,
              formatter: (params: { data?: { exact?: string } }) => (params.data?.exact !== undefined ? kit.labelFormatters[0](params.data.exact) : ""),
            }
          : { show: false },
        labelLayout: { hideOverlap: true },
      },
    ] as EChartsOption["series"],
  };
}

// --------------------------------------------------------- Map with points

export function pointMapOption(kit: ChartKit): EChartsOption {
  const { spec, rows, theme, format } = kit;
  const fields = spec.series.map((series) => series.field);
  const { points } = mapPoints(rows, fields);
  const bubble = spec.series.length > 2;
  const diameters = bubble ? bubbleSizes(points.map((point) => point.size)) : points.map(() => MARKS.symbolSize + MARKS.ringWidth);
  const colour = kit.seriesColour(0);
  const labels = format.labels ?? {};
  const name = (index: number) => kit.categories[index] ?? "";
  // Names of points in the east go to their left, so they stay on the card on a phone.
  const eastOf = 174.5;
  return {
    ...kit.common,
    legend: { show: false },
    tooltip: {
      ...(kit.common.tooltip as Record<string, unknown>),
      trigger: "item" as const,
      formatter: (params: unknown) => {
        const entry = params as { seriesType?: string; data?: { row?: number } };
        if (entry.seriesType !== "scatter" || entry.data?.row === undefined) return "";
        const row = rows[entry.data.row];
        const list: TooltipRow[] = spec.series.map((series, index) => ({
          colour: index === 2 ? colour : "transparent",
          name: series.label,
          value: row[series.field] === null ? "—" : kit.fullFormatters[index](row[series.field] as string | number),
        }));
        return tooltipHtml(theme, name(entry.data.row), list);
      },
    },
    // The regions as a quiet background: no outside map or tiles.
    geo: {
      map: MAP_IDS.regions,
      roam: false,
      silent: true,
      top: kit.compact ? 4 : 8,
      bottom: kit.compact ? 4 : 8,
      left: "center",
      itemStyle: { areaColor: theme.grid, borderColor: theme.background, borderWidth: 0.8 },
      emphasis: { disabled: true },
      label: { show: false },
    },
    series: [
      {
        type: "scatter",
        coordinateSystem: "geo",
        name: spec.series[0].label,
        data: points.map((point, at) => {
          const own = kit.groupColour(point.row) ?? (bubble ? kit.ruleColour(2, rows[point.row][fields[2]]) : undefined);
          return {
            value: point.at,
            name: name(point.row),
            row: point.row,
            symbolSize: diameters[at],
            ...(own ? { itemStyle: { color: own } } : {}),
            ...(labels.show && point.at[0] > eastOf ? { label: { position: "left" as const } } : {}),
          };
        }),
        // A ring in the card's colour keeps dots that touch apart; bubbles are a little see-through.
        itemStyle: { color: colour, borderColor: theme.background, borderWidth: MARKS.ringWidth, ...(bubble ? { opacity: 0.78 } : {}) },
        emphasis: { scale: 1.15, itemStyle: { opacity: 1 } },
        ...(labels.show
          ? {
              label: { show: true, position: "right", width: 120, overflow: "truncate", color: labels.color ?? kit.secondaryText, fontSize: kit.labelSize, formatter: (params: { name?: string }) => params.name ?? "" },
              labelLayout: { hideOverlap: true },
            }
          : {}),
      },
    ] as EChartsOption["series"],
  };
}
