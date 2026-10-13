import { Geodesic } from "geographiclib-geodesic";

/*
 * Paddock shapes (#249 stage 1, decision 514): GeoJSON polygons in WGS84
 * longitude and latitude, checked and measured here rather than by PostGIS.
 * Areas are geodesic on the WGS84 ellipsoid (GeographicLib), in hectares.
 * Shared with the browser, so no server imports.
 */

export type Position = [number, number];
export type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
export type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
export type PaddockGeometry = PolygonGeometry | MultiPolygonGeometry;

export class GeometryError extends Error {}

const MAX_POINTS = 20_000;

function isNumberPair(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Do segments p1-p2 and p3-p4 cross (touching at a shared end doesn't count)? */
function segmentsCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function checkRing(raw: unknown, label: string): Position[] {
  if (!Array.isArray(raw)) throw new GeometryError(`${label} isn't a list of points.`);
  const ring = raw.map((point, index) => {
    if (!isNumberPair(point)) throw new GeometryError(`${label}, point ${index + 1}, isn't a longitude and latitude.`);
    const [lon, lat] = point;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new GeometryError(`${label}, point ${index + 1}, is outside longitude -180 to 180 and latitude -90 to 90. Is the file in NZTM rather than longitude and latitude?`);
    }
    return [lon, lat] as Position;
  });
  if (ring.length < 4) throw new GeometryError(`${label} needs at least three corners.`);
  if (!samePoint(ring[0], ring[ring.length - 1])) throw new GeometryError(`${label} isn't closed: its last point should be its first.`);
  // Edges that cross make the area meaningless.
  const edges = ring.length - 1;
  if (edges <= 2_000) {
    for (let i = 0; i < edges; i += 1) {
      for (let j = i + 2; j < edges; j += 1) {
        if (i === 0 && j === edges - 1) continue;
        if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) throw new GeometryError(`${label} crosses itself.`);
      }
    }
  }
  return ring;
}

/** Checks a GeoJSON Polygon or MultiPolygon (a Feature's geometry, or the geometry itself). */
export function parseGeometry(input: unknown): PaddockGeometry {
  const value = input && typeof input === "object" && (input as { type?: unknown }).type === "Feature" ? (input as { geometry?: unknown }).geometry : input;
  if (!value || typeof value !== "object") throw new GeometryError("There's no shape.");
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  let total = 0;
  const polygon = (raw: unknown, label: string): Position[][] => {
    if (!Array.isArray(raw) || raw.length === 0) throw new GeometryError(`${label} has no outline.`);
    return raw.map((ring, index) => {
      const checked = checkRing(ring, index === 0 ? `${label}'s outline` : `${label}'s hole ${index}`);
      total += checked.length;
      if (total > MAX_POINTS) throw new GeometryError(`The shape has more than ${MAX_POINTS.toLocaleString("en-NZ")} points. Simplify it first.`);
      return checked;
    });
  };
  if (type === "Polygon") return { type: "Polygon", coordinates: polygon(coordinates, "The shape") };
  if (type === "MultiPolygon") {
    if (!Array.isArray(coordinates) || coordinates.length === 0) throw new GeometryError("The shape has no parts.");
    return { type: "MultiPolygon", coordinates: coordinates.map((part, index) => polygon(part, `Part ${index + 1}`)) };
  }
  throw new GeometryError(`A paddock is a Polygon or MultiPolygon, not ${typeof type === "string" ? type : "that"}.`);
}

const geodesic = Geodesic.WGS84;

function ringArea(ring: Position[]): number {
  const polygon = geodesic.Polygon(false);
  // The closing point repeats the first; GeographicLib closes the ring itself.
  for (const [lon, lat] of ring.slice(0, -1)) polygon.AddPoint(lat, lon);
  return Math.abs(polygon.Compute(false, true).area ?? 0);
}

/** The shape's area in hectares: outlines less holes, geodesic on WGS84. */
export function areaHectares(geometry: PaddockGeometry): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let squareMetres = 0;
  for (const [outline, ...holes] of polygons) {
    squareMetres += ringArea(outline);
    for (const hole of holes) squareMetres -= ringArea(hole);
  }
  return squareMetres / 10_000;
}

/** Hectares to 2 decimal places, as text. */
export function hectaresText(hectares: number): string {
  return (Math.round(hectares * 100) / 100).toFixed(2);
}

/** [west, south, east, north] of one or more shapes. */
export function bounds(geometries: PaddockGeometry[]): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const geometry of geometries) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      for (const [lon, lat] of polygon[0]) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}
