import { Geodesic } from "geographiclib-geodesic";
import { areaHectares, type Position } from "@/lib/farming/geometry";

/*
 * Farm map assets and measuring (decisions 1462-1465; examples MA1-MA6,
 * not yet reviewed). Pure and browser-safe: shared by the Map tab and the
 * server. Tested in tests/unit/map-assets.test.ts.
 *
 * - An asset is a point (a trough, gate, water point, shed, bore, tank,
 *   yard, culvert or other) or a line (a fence, water pipe, race, drain or
 *   other), with a name and a note.
 * - Distances are geodesic on WGS84 (GeographicLib), as paddock areas are:
 *   metres under 1 km, then km to two places.
 * - A measured area is a closed shape, in m² under a hectare and then
 *   hectares to two places, with the hectares always given.
 */

export const POINT_KINDS = ["trough", "gate", "water_point", "shed", "bore", "tank", "yard", "culvert", "other_point"] as const;
export const LINE_KINDS = ["fence", "pipe", "race", "drain", "other_line"] as const;
export const ASSET_KINDS = [...POINT_KINDS, ...LINE_KINDS] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  trough: "Trough",
  gate: "Gate",
  water_point: "Water point",
  shed: "Shed",
  bore: "Bore",
  tank: "Tank",
  yard: "Yards",
  culvert: "Culvert or bridge",
  other_point: "Other point",
  fence: "Fence",
  pipe: "Water pipe",
  race: "Race or track",
  drain: "Drain",
  other_line: "Other line",
};

/** The letter on the map's dot, so assets can be told apart without colour. */
export const ASSET_KIND_SHORT: Record<AssetKind, string> = {
  trough: "Tr",
  gate: "G",
  water_point: "W",
  shed: "S",
  bore: "B",
  tank: "Tk",
  yard: "Y",
  culvert: "C",
  other_point: "•",
  fence: "F",
  pipe: "P",
  race: "R",
  drain: "D",
  other_line: "L",
};

export function isLineKind(kind: AssetKind): boolean {
  return (LINE_KINDS as readonly string[]).includes(kind);
}

const WGS84 = Geodesic.WGS84;

/** The geodesic distance between two points, in metres. */
export function distanceMetres(a: Position, b: Position): number {
  return WGS84.Inverse(a[1], a[0], b[1], b[0]).s12 ?? 0;
}

/** A line's length (its legs added), in metres. */
export function lengthMetres(points: readonly Position[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distanceMetres(points[index - 1], points[index]);
  return total;
}

/** "640 m" under a kilometre, then "1.25 km". */
export function distanceText(metres: number): string {
  if (metres < 1000) return `${Math.round(metres).toLocaleString("en-NZ")} m`;
  return `${(Math.round(metres / 10) / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

/** A drawn shape's area in hectares: its corners in order, closed for you. Zero with fewer than three corners. */
export function drawnHectares(corners: readonly Position[]): number {
  if (corners.length < 3) return 0;
  return areaHectares({ type: "Polygon", coordinates: [[...corners, corners[0]]] });
}

/** "4,500 m² (0.45 ha)" under a hectare, then "12.34 ha". */
export function areaText(hectares: number): string {
  if (hectares < 1) return `${Math.round(hectares * 10_000).toLocaleString("en-NZ")} m² (${hectares.toFixed(2)} ha)`;
  return `${(Math.round(hectares * 100) / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

/** The map's layers people can turn on and off. Overlays are told apart by their ids and tones. */
export const MAP_LAYERS = [
  { key: "hazards", label: "Hazards" },
  { key: "effluent", label: "Effluent" },
  { key: "assets", label: "Farm assets" },
  { key: "rain", label: "Rain gauges" },
  { key: "tasks", label: "Tasks" },
  { key: "people", label: "People" },
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number]["key"];

/** Which layer an overlay is on: assets, rain gauges and tasks by their id's start, effluent by its tone, hazards otherwise. */
export function overlayLayer(overlay: { id: string; tone: string }): MapLayer {
  if (overlay.id.startsWith("asset-")) return "assets";
  if (overlay.id.startsWith("gauge-")) return "rain";
  if (overlay.id.startsWith("task-")) return "tasks";
  if (overlay.tone === "effluent" || overlay.tone === "buffer") return "effluent";
  return "hazards";
}
