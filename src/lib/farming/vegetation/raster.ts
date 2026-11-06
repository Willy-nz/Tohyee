import { bounds, fromWorld, type PaddockGeometry, type Position, toWorld } from "@/lib/farming/geometry";
import { CHANGE_SCALE, GROUND_PIXEL_METRES, MAX_PIXELS, MAX_SIDE, MISSING_COLOURS, NDVI_SCALE, paddockQuality, type Quality, type QualityFlag, scaleStep, type Thresholds } from "@/lib/farming/vegetation/rules";

/*
 * Greenness from satellite bands (#612, decisions 1524-1530). Pure, no
 * Node or browser APIs; tested against small hand-made rasters in
 * tests/unit/vegetation-raster.test.ts.
 *
 * Everything is on one grid a farm: Web Mercator (EPSG:3857) metres, the
 * projection the farm map draws in, so a picture lies on the map without
 * being warped again. Pixels are about 10 m on the ground (Sentinel-2's
 * red and near-infrared bands), which in Web Mercator is 10 / cos(latitude)
 * metres; the grid is snapped to multiples of that size, so two pictures
 * of the same farm line up pixel for pixel even if the paddocks' outline
 * box changes a little (decision 1524). The provider resamples its bands
 * onto this grid (nearest neighbour); that adds no detail.
 */

const EARTH_RADIUS = 6378137;
const CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

/** A position as Web Mercator metres [x east, y north]. */
export function toMercator(position: Position): [number, number] {
  const [wx, wy] = toWorld(position);
  return [(wx - 0.5) * CIRCUMFERENCE, (0.5 - wy) * CIRCUMFERENCE];
}

export function fromMercator([x, y]: [number, number]): Position {
  return fromWorld([x / CIRCUMFERENCE + 0.5, 0.5 - y / CIRCUMFERENCE]);
}

/** A picture's grid: its top-left corner, pixel size (Web Mercator metres) and size in pixels. */
export type Grid = { crs: "EPSG:3857"; pixel: number; minX: number; maxY: number; width: number; height: number };

/** The grid's box in Web Mercator metres: [minX, minY, maxX, maxY]. */
export function gridBox(grid: Grid): [number, number, number, number] {
  return [grid.minX, grid.maxY - grid.height * grid.pixel, grid.minX + grid.width * grid.pixel, grid.maxY];
}

/** The grid's box in longitude and latitude: [west, south, east, north]. */
export function gridLonLatBox(grid: Grid): [number, number, number, number] {
  const [minX, minY, maxX, maxY] = gridBox(grid);
  const [west, south] = fromMercator([minX, minY]);
  const [east, north] = fromMercator([maxX, maxY]);
  return [west, south, east, north];
}

export class GridError extends Error {}

/**
 * The grid for a farm's paddocks (decision 1524): their outline box plus a
 * 50 m margin, snapped outward to whole pixels. The pixel size is rounded
 * to 0.5 m, so the same farm keeps the same size.
 */
export function farmGrid(geometries: PaddockGeometry[], marginMetres = 50): Grid {
  const box = bounds(geometries);
  if (!box) throw new GridError("The farm has no paddock boundaries yet.");
  const [west, south, east, north] = box;
  const middle = ((south + north) / 2) * (Math.PI / 180);
  const pixel = Math.round((GROUND_PIXEL_METRES / Math.cos(middle)) * 2) / 2;
  const margin = marginMetres / Math.cos(middle);
  const [x0, y0] = toMercator([west, south]);
  const [x1, y1] = toMercator([east, north]);
  const minX = Math.floor((x0 - margin) / pixel) * pixel;
  const minY = Math.floor((y0 - margin) / pixel) * pixel;
  const maxX = Math.ceil((x1 + margin) / pixel) * pixel;
  const maxY = Math.ceil((y1 + margin) / pixel) * pixel;
  const width = Math.round((maxX - minX) / pixel);
  const height = Math.round((maxY - minY) / pixel);
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new GridError(`The farm is too big for one picture (${width} × ${height} pixels; the most is ${MAX_PIXELS.toLocaleString("en-NZ")} pixels, about 100 km²).`);
  }
  return { crs: "EPSG:3857", pixel, minX, maxY, width, height };
}

// Bands and masks ------------------------------------------------------------------------------

/**
 * One picture's bands on a grid, a value a pixel, row by row from the
 * top-left: red (B04) and near-infrared (B08) as digital numbers, and the
 * scene classification (SCL), with 0 where there's no data.
 */
export type BandRaster = { width: number; height: number; red: Uint16Array; nir: Uint16Array; scl: Uint8Array };

/**
 * Scene classification classes kept as a clear view of the ground
 * (decision 1525): 4 vegetation and 5 not vegetated. Everything else is
 * missing: 0 no data, 1 saturated or defective, 2 dark area or topographic
 * shadow, 3 cloud shadow, 6 water, 7 unclassified, 8 and 9 cloud, 10 thin
 * cirrus, 11 snow or ice. Unclassified is left out to be careful: it's
 * often haze at cloud edges.
 */
export const CLEAR_CLASSES: ReadonlySet<number> = new Set([4, 5]);

/**
 * NDVI from Sentinel-2 L2A digital numbers (decision 1526):
 * reflectance = (DN + offset) / 10000, then (NIR − red) / (NIR + red).
 * The provider's harmonised values have the offset taken off already
 * (offset 0); raw products from processing baseline 04.00 on have
 * BOA_ADD_OFFSET −1000, and pass that. The 10000 divides out, but the
 * offset doesn't, so it matters. Null when either band is 0 or less after
 * the offset (no data), or they sum to 0.
 */
export function ndviOf(red: number, nir: number, offset = 0): number | null {
  const r = (red + offset) / 10000;
  const n = (nir + offset) / 10000;
  if (red === 0 || nir === 0 || r <= 0 || n <= 0) return null;
  const sum = n + r;
  if (sum === 0) return null;
  return (n - r) / sum;
}

/** Each pixel's NDVI, NaN where it's masked (cloud, shadow, water, no data and the rest, decision 1525). */
export function ndviRaster(bands: BandRaster, offset = 0): Float32Array {
  const out = new Float32Array(bands.width * bands.height);
  for (let i = 0; i < out.length; i += 1) {
    const value = CLEAR_CLASSES.has(bands.scl[i]) ? ndviOf(bands.red[i], bands.nir[i], offset) : null;
    out[i] = value === null ? Number.NaN : value;
  }
  return out;
}

// Which pixels are in a paddock ----------------------------------------------------------------

function inRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type MercatorPolygon = Array<Array<[number, number]>>;

function toMercatorPolygons(geometry: PaddockGeometry): MercatorPolygon[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => polygon.map((ring) => ring.map(toMercator)));
}

function inPolygons(x: number, y: number, polygons: MercatorPolygon[]): boolean {
  return polygons.some(([outline, ...holes]) => inRing(x, y, outline) && !holes.some((hole) => inRing(x, y, hole)));
}

/**
 * A paddock's pixels (decision 1524): those whose centre is inside it.
 * An edge pixel is one with a corner outside, so it also sees the fence,
 * race or next paddock. A paddock narrower than a pixel may have none.
 */
export function paddockPixels(grid: Grid, geometry: PaddockGeometry): { pixels: Uint32Array; edge: Uint8Array } {
  const polygons = toMercatorPolygons(geometry);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const c0 = Math.max(0, Math.floor((minX - grid.minX) / grid.pixel));
  const c1 = Math.min(grid.width - 1, Math.floor((maxX - grid.minX) / grid.pixel));
  const r0 = Math.max(0, Math.floor((grid.maxY - maxY) / grid.pixel));
  const r1 = Math.min(grid.height - 1, Math.floor((grid.maxY - minY) / grid.pixel));
  const pixels: number[] = [];
  const edge: number[] = [];
  const half = grid.pixel / 2;
  for (let row = r0; row <= r1; row += 1) {
    const y = grid.maxY - (row + 0.5) * grid.pixel;
    for (let col = c0; col <= c1; col += 1) {
      const x = grid.minX + (col + 0.5) * grid.pixel;
      if (!inPolygons(x, y, polygons)) continue;
      pixels.push(row * grid.width + col);
      const corners: Array<[number, number]> = [
        [x - half, y - half],
        [x + half, y - half],
        [x - half, y + half],
        [x + half, y + half],
      ];
      edge.push(corners.every(([cx, cy]) => inPolygons(cx, cy, polygons)) ? 0 : 1);
    }
  }
  return { pixels: Uint32Array.from(pixels), edge: Uint8Array.from(edge) };
}

// A paddock's numbers --------------------------------------------------------------------------

export type PaddockStats = {
  totalPixels: number;
  validPixels: number;
  edgePixels: number;
  /** Null when nothing was clear: missing is never 0 (decision 1530). */
  meanNdvi: number | null;
  medianNdvi: number | null;
  coveragePct: number | null;
  quality: Quality;
  flags: QualityFlag[];
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mean and median NDVI of a paddock's clear pixels, how many there are and how much of it they cover. */
export function paddockStats(ndvi: Float32Array, member: { pixels: Uint32Array; edge: Uint8Array }, thresholds: Thresholds): PaddockStats {
  const values: number[] = [];
  let edgePixels = 0;
  for (let i = 0; i < member.pixels.length; i += 1) {
    edgePixels += member.edge[i];
    const value = ndvi[member.pixels[i]];
    if (!Number.isNaN(value)) values.push(value);
  }
  const totalPixels = member.pixels.length;
  const { quality, coveragePct, flags } = paddockQuality({ totalPixels, validPixels: values.length, edgePixels }, thresholds);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    totalPixels,
    validPixels: values.length,
    edgePixels,
    meanNdvi: mean === null ? null : round4(mean),
    medianNdvi: values.length ? round4(median(values)) : null,
    coveragePct,
    quality,
    flags,
  };
}

/**
 * Where a pixel of one grid is in another of the same pixel size and
 * snapping, or -1 (outside, or the grids don't line up).
 */
export function pixelOffset(from: Grid, to: Grid): { dCol: number; dRow: number } | null {
  if (from.pixel !== to.pixel) return null;
  const dCol = (from.minX - to.minX) / from.pixel;
  const dRow = (to.maxY - from.maxY) / from.pixel;
  if (Math.abs(dCol - Math.round(dCol)) > 1e-6 || Math.abs(dRow - Math.round(dRow)) > 1e-6) return null;
  return { dCol: Math.round(dCol), dRow: Math.round(dRow) };
}

/**
 * The change in a paddock since an earlier date (decision 1530), only over
 * pixels clear on both, so a different gap in the cloud can't look like
 * change. Null unless enough of the paddock is clear on both.
 */
export function paddockChange(
  now: { grid: Grid; ndvi: Float32Array },
  earlier: { grid: Grid; ndvi: Float32Array },
  member: { pixels: Uint32Array },
  thresholds: Thresholds,
): { change: number | null; commonPixels: number } {
  const offset = pixelOffset(now.grid, earlier.grid);
  if (!offset || member.pixels.length === 0) return { change: null, commonPixels: 0 };
  let sum = 0;
  let common = 0;
  for (const index of member.pixels) {
    const a = now.ndvi[index];
    if (Number.isNaN(a)) continue;
    const col = (index % now.grid.width) + offset.dCol;
    const row = Math.floor(index / now.grid.width) + offset.dRow;
    if (col < 0 || row < 0 || col >= earlier.grid.width || row >= earlier.grid.height) continue;
    const b = earlier.ndvi[row * earlier.grid.width + col];
    if (Number.isNaN(b)) continue;
    sum += a - b;
    common += 1;
  }
  const enough = common >= thresholds.minValidPixels && (common / member.pixels.length) * 100 >= thresholds.minCoveragePct;
  return { change: enough ? round4(sum / common) : null, commonPixels: common };
}

// Pictures for the map ---------------------------------------------------------------------------

/** Missing pixels are grey stripes, two pixels wide, so they never look like pasture (decision 1532). */
function missing(col: number, row: number): [number, number, number] {
  return (col + row) % 4 < 2 ? MISSING_COLOURS.light : MISSING_COLOURS.dark;
}

/**
 * The map picture (RGBA, 8 bits): each paddock pixel coloured on the fixed
 * scale, missing ones striped grey, everything outside paddocks clear. With
 * `earlier`, the change since then instead (missing unless clear on both).
 */
export function overlayPixels(grid: Grid, ndvi: Float32Array, inPaddock: Uint8Array, earlier?: { grid: Grid; ndvi: Float32Array }): Uint8Array {
  const rgba = new Uint8Array(grid.width * grid.height * 4);
  const offset = earlier ? pixelOffset(grid, earlier.grid) : null;
  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const index = row * grid.width + col;
      if (!inPaddock[index]) continue;
      let colour: [number, number, number];
      const value = ndvi[index];
      if (earlier) {
        let before = Number.NaN;
        if (offset) {
          const c = col + offset.dCol;
          const r = row + offset.dRow;
          if (c >= 0 && r >= 0 && c < earlier.grid.width && r < earlier.grid.height) before = earlier.ndvi[r * earlier.grid.width + c];
        }
        colour = Number.isNaN(value) || Number.isNaN(before) ? missing(col, row) : scaleStep(CHANGE_SCALE, value - before).colour;
      } else {
        colour = Number.isNaN(value) ? missing(col, row) : scaleStep(NDVI_SCALE, value).colour;
      }
      rgba.set([colour[0], colour[1], colour[2], 230], index * 4);
    }
  }
  return rgba;
}

/** Share of the farm's paddock pixels that are clear, in percent (two places), or null with no paddock pixels. */
export function clearShare(ndvi: Float32Array, inPaddock: Uint8Array): number | null {
  let total = 0;
  let clear = 0;
  for (let i = 0; i < inPaddock.length; i += 1) {
    if (!inPaddock[i]) continue;
    total += 1;
    if (!Number.isNaN(ndvi[i])) clear += 1;
  }
  return total ? Math.round((clear / total) * 10000) / 100 : null;
}
