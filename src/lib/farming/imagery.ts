import { addDays, daysBetween } from "@/lib/farming/farm-words";
import { bounds, type PaddockGeometry, type Position, toWorld } from "@/lib/farming/geometry";

/*
 * Aerial photos on farm maps from the organisation's own LINZ Basemaps key
 * (#485, decisions 1060-1066). Browser-safe and pure: the key's age and
 * reminder, the one test tile used to check a key, and which tiles cover a
 * farm's area for keeping on a phone.
 */

/** LINZ Basemaps, where a key is copied from. */
export const LINZ_BASEMAPS_URL = "https://basemaps.linz.govt.nz";

/** A standard LINZ key lasts 90 days (LINZ's technical documentation); Tohyee reminds at 80 (decision 1061). */
export const STANDARD_KEY_DAYS = 90;
export const REMIND_AFTER_DAYS = 80;

export type KeyAge = {
  savedOn: string;
  /** The day the reminder starts, and the day a standard key runs out. */
  remindOn: string;
  expiresOn: string;
  /** "fine" before the reminder; "remind" from day 80; "expired" from day 90 (a developer key doesn't run out). */
  stage: "fine" | "remind" | "expired";
  daysLeft: number;
};

/** How old the saved key is, from the day it was saved (YYYY-MM-DD), or null with no key or no saved date. */
export function keyAge(savedOn: string | null, today: string): KeyAge | null {
  if (!savedOn) return null;
  const age = daysBetween(savedOn, today);
  const daysLeft = STANDARD_KEY_DAYS - age;
  return {
    savedOn,
    remindOn: addDays(savedOn, REMIND_AFTER_DAYS),
    expiresOn: addDays(savedOn, STANDARD_KEY_DAYS),
    stage: age >= STANDARD_KEY_DAYS ? "expired" : age >= REMIND_AFTER_DAYS ? "remind" : "fine",
    daysLeft: Math.max(0, daysLeft),
  };
}

export type TileId = { z: number; x: number; y: number };

/** The tile (XYZ numbering, Web Mercator) that holds a point at a zoom. */
export function tileAt(position: Position, z: number): TileId {
  const count = 2 ** z;
  const [x, y] = toWorld(position);
  return { z, x: Math.min(count - 1, Math.max(0, Math.floor(x * count))), y: Math.min(count - 1, Math.max(0, Math.floor(y * count))) };
}

/** The one tile a key is checked with: central Wellington at zoom 12, where LINZ always has imagery. */
export const TEST_TILE: TileId = tileAt([174.7762, -41.2865], 12);

/** A LINZ aerial tile's address without the key: how a phone keeps it (a new key doesn't make it a new photo). */
export function tileCacheUrl(tile: TileId): string {
  return `${LINZ_BASEMAPS_URL}/v1/tiles/aerial/3857/${tile.z}/${tile.x}/${tile.y}.webp`;
}

export type Box = [west: number, south: number, east: number, north: number];

/** Metres in a degree of latitude (near enough for a margin). */
const METRES_PER_DEGREE = 111_320;

/** The farm's area: the paddocks' bounding box plus a margin on every side (300 m, decision 1064), or null with no shapes. */
export function farmArea(geometries: PaddockGeometry[], marginMetres = 300): Box | null {
  const box = bounds(geometries);
  if (!box) return null;
  const [west, south, east, north] = box;
  const middle = ((south + north) / 2) * (Math.PI / 180);
  const dLat = marginMetres / METRES_PER_DEGREE;
  const dLon = marginMetres / (METRES_PER_DEGREE * Math.max(0.01, Math.cos(middle)));
  return [west - dLon, Math.max(-85, south - dLat), east + dLon, Math.min(85, north + dLat)];
}

/** The tiles at one zoom that cover a box, west to east, north to south. */
export function tilesInBox(box: Box, z: number): TileId[] {
  const [west, south, east, north] = box;
  const topLeft = tileAt([west, north], z);
  const bottomRight = tileAt([east, south], z);
  const tiles: TileId[] = [];
  for (let y = topLeft.y; y <= bottomRight.y; y += 1) for (let x = topLeft.x; x <= bottomRight.x; x += 1) tiles.push({ z, x, y });
  return tiles;
}

/** Zoom 14 shows the whole farm; 18 shows gateways and troughs. LINZ's aerial imagery goes deeper, but that's a lot of photos for little more (decision 1064). */
export const OFFLINE_MIN_ZOOM = 14;
export const OFFLINE_MAX_ZOOM = 18;
/** At most this many photos per farm, and in all on a device (decision 1064). */
export const OFFLINE_MAX_TILES_PER_FARM = 1500;
export const OFFLINE_MAX_TILES = 4000;
/** And at most this many bytes in all on a device. */
export const OFFLINE_MAX_BYTES = 100 * 1024 * 1024;
/** A rough size per photo for the estimate before anything is kept (LINZ WebP tiles are mostly 10-40 KB). */
export const ESTIMATED_TILE_BYTES = 25 * 1024;

export type TilePlan = {
  tiles: TileId[];
  /** The zooms kept, lowest first; empty when even the widest zoom is over the cap. */
  zooms: number[];
  /** Closer zooms left out to stay under the cap. */
  leftOut: number[];
  estimatedBytes: number;
};

/**
 * The tiles to keep for one farm: every zoom from `minZoom` up while the
 * running total stays within `maxTiles`. Closer zooms are dropped first, so
 * a big station keeps its whole area at fewer zooms rather than part of it.
 */
export function planFarmTiles(box: Box, options: { minZoom?: number; maxZoom?: number; maxTiles?: number } = {}): TilePlan {
  const minZoom = options.minZoom ?? OFFLINE_MIN_ZOOM;
  const maxZoom = options.maxZoom ?? OFFLINE_MAX_ZOOM;
  const maxTiles = options.maxTiles ?? OFFLINE_MAX_TILES_PER_FARM;
  const tiles: TileId[] = [];
  const zooms: number[] = [];
  const leftOut: number[] = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const level = leftOut.length ? [] : tilesInBox(box, z);
    if (leftOut.length || tiles.length + level.length > maxTiles) {
      leftOut.push(z);
      continue;
    }
    tiles.push(...level);
    zooms.push(z);
  }
  return { tiles, zooms, leftOut, estimatedBytes: tiles.length * ESTIMATED_TILE_BYTES };
}

export type FarmTilePlan = { farmId: string; farmName: string; plan: TilePlan; tiles: TileId[] };

/**
 * Plans every farm on the device together: each farm's own plan, then
 * tiles another farm already has are shared, and farms past the device's
 * total cap keep nothing (in the order given).
 */
export function planDeviceTiles(farms: Array<{ farmId: string; farmName: string; box: Box | null }>, maxTotal = OFFLINE_MAX_TILES): FarmTilePlan[] {
  const seen = new Set<string>();
  const result: FarmTilePlan[] = [];
  for (const farm of farms) {
    if (!farm.box) continue;
    const plan = planFarmTiles(farm.box);
    const fresh = plan.tiles.filter((tile) => !seen.has(`${tile.z}/${tile.x}/${tile.y}`));
    if (seen.size + fresh.length > maxTotal) {
      result.push({ farmId: farm.farmId, farmName: farm.farmName, plan: { tiles: [], zooms: [], leftOut: [...plan.zooms, ...plan.leftOut], estimatedBytes: 0 }, tiles: [] });
      continue;
    }
    for (const tile of fresh) seen.add(`${tile.z}/${tile.x}/${tile.y}`);
    result.push({ farmId: farm.farmId, farmName: farm.farmName, plan, tiles: plan.tiles });
  }
  return result;
}
