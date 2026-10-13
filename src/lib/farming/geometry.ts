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

// Web Mercator, for drawing paddocks over map tiles ---------------------------------------------

const TILE = 256;
const MAX_LATITUDE = 85.0511287798;

/** Longitude and latitude to Web Mercator world coordinates, 0 to 1 across and down. */
export function toWorld([lon, lat]: Position): [number, number] {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

export type MapTile = { z: number; x: number; y: number; left: number; top: number; size: number };

export type MapView = {
  /** The zoom the shapes are drawn at (it can be fractional). */
  zoom: number;
  /** The centre of the drawing. */
  centre: Position;
  /** A point's position in the drawing, in pixels. */
  project: (position: Position) => [number, number];
  /** The longitude and latitude at a position in the drawing. */
  unproject: (pixel: [number, number]) => Position;
  /** The tiles that cover the drawing, at a whole-number zoom, scaled to fit. */
  tiles: MapTile[];
};

/** World coordinates back to longitude and latitude. */
export function fromWorld([x, y]: [number, number]): Position {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

/** The centre and zoom that fit [west, south, east, north] into a width × height drawing, less `pad` on each side. */
export function fitBox(box: [number, number, number, number], width: number, height: number, options: { pad?: number; maxZoom?: number } = {}): { centre: Position; zoom: number } {
  const pad = options.pad ?? 24;
  const maxZoom = options.maxZoom ?? 19;
  const [west, south, east, north] = box;
  const [left, top] = toWorld([west, north]);
  const [right, bottom] = toWorld([east, south]);
  const across = right - left;
  const down = bottom - top;
  const fits = [across > 0 ? Math.log2((width - pad * 2) / (across * TILE)) : maxZoom, down > 0 ? Math.log2((height - pad * 2) / (down * TILE)) : maxZoom];
  return { centre: fromWorld([(left + right) / 2, (top + bottom) / 2]), zoom: Math.max(0, Math.min(maxZoom, ...fits)) };
}

/**
 * A width × height drawing centred on `centre` at `zoom`, north up, in Web
 * Mercator, with the 256-pixel tiles (XYZ numbering) that cover it, fetched
 * at no more than `maxTileZoom`.
 */
export function mapViewAt(centre: Position, zoom: number, width: number, height: number, options: { maxTileZoom?: number } = {}): MapView {
  const maxTileZoom = options.maxTileZoom ?? 19;
  const worldPixels = TILE * 2 ** zoom;
  const [centreX, centreY] = toWorld(centre);
  const project = (position: Position): [number, number] => {
    const [x, y] = toWorld(position);
    return [(x - centreX) * worldPixels + width / 2, (y - centreY) * worldPixels + height / 2];
  };
  const unproject = ([px, py]: [number, number]): Position => fromWorld([(px - width / 2) / worldPixels + centreX, (py - height / 2) / worldPixels + centreY]);
  const tileZoom = Math.max(0, Math.min(maxTileZoom, Math.ceil(zoom)));
  const count = 2 ** tileZoom;
  const size = worldPixels / count;
  // The drawing's edges in world coordinates.
  const viewLeft = centreX - width / 2 / worldPixels;
  const viewTop = centreY - height / 2 / worldPixels;
  const viewRight = centreX + width / 2 / worldPixels;
  const viewBottom = centreY + height / 2 / worldPixels;
  const tiles: MapTile[] = [];
  const firstY = Math.max(0, Math.floor(viewTop * count));
  const lastY = Math.min(count - 1, Math.floor(viewBottom * count));
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = Math.floor(viewLeft * count); x <= Math.floor(viewRight * count); x += 1) {
      tiles.push({ z: tileZoom, x: ((x % count) + count) % count, y, left: (x / count - centreX) * worldPixels + width / 2, top: (y / count - centreY) * worldPixels + height / 2, size });
    }
  }
  return { zoom, centre, project, unproject, tiles };
}

/**
 * Fits [west, south, east, north] into a width × height drawing (less `pad`
 * on each side) in Web Mercator, north up, and lists the 256-pixel tiles
 * (XYZ numbering) that cover it. Tiles are fetched at no more than `maxTileZoom`.
 */
export function mapView(box: [number, number, number, number], width: number, height: number, options: { pad?: number; maxZoom?: number; maxTileZoom?: number } = {}): MapView {
  const { centre, zoom } = fitBox(box, width, height, options);
  return mapViewAt(centre, zoom, width, height, options);
}

/** A LINZ Basemaps aerial imagery tile (Web Mercator, EPSG:3857), as LINZ documents it. */
export function linzAerialTileUrl(tile: { z: number; x: number; y: number }, apiKey: string): string {
  return `https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/${tile.z}/${tile.x}/${tile.y}.webp?api=${encodeURIComponent(apiKey)}`;
}

function pointInRing([x, y]: Position, ring: Position[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

/** A point inside a ring: its area centroid when that falls inside (any convex ring), otherwise null. */
function interiorPoint(ring: Position[]): Position | null {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    area += cross;
    x += (ring[i][0] + ring[i + 1][0]) * cross;
    y += (ring[i][1] + ring[i + 1][1]) * cross;
  }
  if (area === 0) return null;
  const centre: Position = [x / (3 * area), y / (3 * area)];
  return pointInRing(centre, ring) ? centre : null;
}

/**
 * Whether two shapes' outlines overlap: an edge of one crosses an edge of
 * the other, or one lies inside the other. Shapes that only touch along a
 * shared fence line don't count. Used to warn, never to refuse.
 */
export function outlinesOverlap(a: PaddockGeometry, b: PaddockGeometry): boolean {
  const rings = (geometry: PaddockGeometry) => (geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]));
  for (const first of rings(a)) {
    for (const second of rings(b)) {
      for (let i = 0; i < first.length - 1; i += 1) {
        for (let j = 0; j < second.length - 1; j += 1) {
          if (segmentsCross(first[i], first[i + 1], second[j], second[j + 1])) return true;
        }
      }
      // No edges cross: one may still sit wholly inside the other. A middle point of an edge avoids shared corners.
      const middle = (ring: Position[]): Position => [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2];
      const inside = (ring: Position[], other: Position[]) => ring.slice(0, -1).some((point) => pointInRing(point, other) && !other.some((corner) => samePoint(corner, point))) || pointInRing(middle(ring), other);
      if (inside(first, second) || inside(second, first)) return true;
      // Identical or nearly identical outlines share every corner and edge: test a point inside each.
      const centre = interiorPoint(first);
      if (centre && pointInRing(centre, second)) return true;
    }
  }
  return false;
}
