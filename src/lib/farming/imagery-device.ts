/*
 * Aerial photos in the browser (#485, decisions 1062-1066): checking a LINZ
 * key by loading one photo, and keeping the farm's area on a phone for use
 * without a signal. Photos come straight from LINZ to the device; Tohyee's
 * server never fetches or stores them (decision 1065).
 *
 * The photos are kept in Cache Storage, one cache per server, account and
 * organisation ("tohyee-tiles-…"), keyed by the photo's address without
 * the key. public/sw-tiles.js answers the map from it when LINZ can't be
 * reached, only within the device's 14-day offline session. Signing out,
 * another person signing in, or the key being removed deletes them.
 *
 * Browser-safe; tests pass a pretend fetch and Cache Storage.
 */

import { linzAerialTileUrl, type PaddockGeometry } from "@/lib/farming/geometry";
import { farmArea, OFFLINE_MAX_BYTES, planDeviceTiles, TEST_TILE, tileCacheUrl, type TileId } from "@/lib/farming/imagery";

// Checking a key --------------------------------------------------------------------------------

export type KeyCheck =
  | { ok: true }
  | {
      ok: false;
      /** "refused": LINZ said no (wrong, part-copied or expired key); "offline": this device has no connection; "failed": the photo didn't load and the browser doesn't say why. */
      reason: "refused" | "offline" | "failed";
    };

type CheckOptions = { fetcher?: typeof fetch; loadImage?: (url: string) => Promise<boolean>; online?: boolean; timeoutMs?: number };

function loadImageInBrowser(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    image.src = url;
  });
}

/**
 * Checks a key where the photos are actually loaded, in this browser
 * (decision 1062): asks LINZ for one photo (central Wellington). A refusal
 * (401 or 403) is told apart where LINZ lets the browser read the answer;
 * otherwise loading it as an image says only whether it worked.
 */
export async function checkImageryKey(key: string, options: CheckOptions = {}): Promise<KeyCheck> {
  const online = options.online ?? (typeof navigator === "undefined" ? true : navigator.onLine);
  if (!online) return { ok: false, reason: "offline" };
  const url = linzAerialTileUrl(TEST_TILE, key.trim());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = options.fetcher ?? (typeof fetch === "undefined" ? null : fetch);
  if (fetcher) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetcher(url, { mode: "cors", credentials: "omit", cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) return { ok: false, reason: "refused" };
      return { ok: false, reason: "failed" };
    } catch {
      // LINZ didn't let the browser read the answer, or it didn't arrive: try it as an image.
    }
  }
  const loadImage = options.loadImage ?? ((address: string) => loadImageInBrowser(address, timeoutMs));
  return (await loadImage(url)) ? { ok: true } : { ok: false, reason: "failed" };
}

// Keeping the farm's area on the device ---------------------------------------------------------

const CACHE_PREFIX = "tohyee-tiles-";

/** FNV-1a, the same as public/sw-rules.js, so a cache's name doesn't spell out whose it is. */
export function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

export type TileScope = { server: string; userId: string; organisationId: string };

/** The photos for one server, account and organisation. public/sw-tiles.js looks in every cache that starts with the account's part. */
export function tileCacheName(scope: TileScope): string {
  return `${CACHE_PREFIX}${hash(`${scope.server}|${scope.userId}`)}-${hash(scope.organisationId)}`;
}

function accountPrefix(server: string, userId: string): string {
  return `${CACHE_PREFIX}${hash(`${server}|${userId}`)}-`;
}

/** Where the summary of what's kept sits in the same cache (never fetched). */
function summaryUrl(scope: TileScope): string {
  return `${scope.server}/__tohyee/aerial-photos-kept`;
}

export type TileSummary = {
  savedAt: string;
  farms: Array<{ farmId: string; farmName: string; tiles: number; zooms: number[]; leftOut: number[] }>;
  tiles: number;
  bytes: number;
  /** Why the last update stopped early, in words; what was kept stays. */
  problem: string | null;
};

export type TileProgress = { done: number; total: number };

type KeepOptions = {
  fetcher?: typeof fetch;
  cacheStorage?: CacheStorage | null;
  now?: () => Date;
  /** Fetch again even when the last update was in the last 12 hours. */
  force?: boolean;
  onProgress?: (progress: TileProgress) => void;
  /** Milliseconds between starting photos: 125 keeps under 500 a minute, half LINZ's standard limit (decision 1064). */
  spacingMs?: number;
  /** Photos kept longer than this are fetched again (imagery changes slowly). */
  maxAgeDays?: number;
};

export type KeepResult = { outcome: "done" | "no_key" | "unavailable" | "recent" | "offline" | "busy"; summary: TileSummary | null };

const REFRESH_HOURS = 12;

function storage(options: KeepOptions): CacheStorage | null {
  if (options.cacheStorage !== undefined) return options.cacheStorage;
  return typeof caches === "undefined" ? null : caches;
}

export async function readTileSummary(scope: TileScope, cacheStorage: CacheStorage | null = typeof caches === "undefined" ? null : caches): Promise<TileSummary | null> {
  if (!cacheStorage) return null;
  try {
    if (!(await cacheStorage.has(tileCacheName(scope)))) return null;
    const cache = await cacheStorage.open(tileCacheName(scope));
    const hit = await cache.match(summaryUrl(scope));
    return hit ? ((await hit.json()) as TileSummary) : null;
  } catch {
    return null;
  }
}

/** Deletes kept photos: every account's (`keepUserId` null), or every account's but one. */
export async function clearFarmTiles(server: string, keepUserId: string | null, cacheStorage: CacheStorage | null = typeof caches === "undefined" ? null : caches): Promise<void> {
  if (!cacheStorage) return;
  try {
    const keep = keepUserId === null ? null : accountPrefix(server, keepUserId);
    const names = await cacheStorage.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && (keep === null || !name.startsWith(keep))).map((name) => cacheStorage.delete(name)));
  } catch {
    // Nothing to delete, or no Cache Storage.
  }
}

/** Deletes this organisation's kept photos (the Offline page's Remove, or the key removed). */
export async function removeFarmTiles(scope: TileScope, cacheStorage: CacheStorage | null = typeof caches === "undefined" ? null : caches): Promise<void> {
  if (!cacheStorage) return;
  try {
    await cacheStorage.delete(tileCacheName(scope));
  } catch {
    // fine
  }
  changed();
}

const listeners = new Set<() => void>();
let version = 0;
let running: TileProgress | null = null;
function changed() {
  version += 1;
  listeners.forEach((listener) => listener());
}
export function subscribeTiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function tilesVersion(): number {
  return version;
}
/** The update running in this tab, if any. */
export function tilesProgress(): TileProgress | null {
  return running;
}

async function getJson<T>(fetcher: typeof fetch, scope: TileScope, path: string): Promise<{ status: number; body: T | null }> {
  const url = new URL(path, scope.server);
  url.searchParams.set("organisationId", scope.organisationId);
  try {
    const response = await fetcher(url, { cache: "no-store", credentials: "same-origin" });
    return { status: response.status, body: response.ok ? ((await response.json()) as T) : null };
  } catch {
    return { status: 0, body: null };
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tileKey = (tile: TileId) => `${tile.z}/${tile.x}/${tile.y}`;

/**
 * Keeps the aerial photos for the area of every farm this person can see
 * (the paddocks' bounding box plus 300 m, zooms 14 to 18, at most 1,500
 * photos a farm, 4,000 and 100 MB in all; decision 1064). Only photos not
 * already kept (or kept more than 90 days ago) are fetched, one every
 * 125 ms. Photos outside the plan are deleted. Stops at the first refusal
 * or lost connection and keeps what arrived.
 */
export async function keepFarmTiles(scope: TileScope, options: KeepOptions = {}): Promise<KeepResult> {
  const cacheStorage = storage(options);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  if (!cacheStorage) return { outcome: "unavailable", summary: null };
  if (running) return { outcome: "busy", summary: null };
  const previous = await readTileSummary(scope, cacheStorage);
  if (!options.force && previous && now().getTime() - Date.parse(previous.savedAt) < REFRESH_HOURS * 3_600_000) return { outcome: "recent", summary: previous };

  const settings = await getJson<{ settings: { enabled: boolean; imageryKey: string | null } }>(fetcher, scope, "/api/farming/settings");
  if (settings.status === 0) return { outcome: "offline", summary: previous };
  const key = settings.body?.settings.enabled ? settings.body.settings.imageryKey : null;
  if (!key) {
    // No key (or no Farming): nothing of LINZ's is kept for this organisation.
    if (settings.body) await removeFarmTiles(scope, cacheStorage);
    return { outcome: "no_key", summary: null };
  }
  const farms = await getJson<{ farms: Array<{ id: string; name: string; isActive: boolean }> }>(fetcher, scope, "/api/farming/farms");
  if (!farms.body) return { outcome: farms.status === 0 ? "offline" : "unavailable", summary: previous };
  const areas: Array<{ farmId: string; farmName: string; box: ReturnType<typeof farmArea> }> = [];
  for (const farm of farms.body.farms.filter((entry) => entry.isActive)) {
    const paddocks = await getJson<{ paddocks: Array<{ status: string; geometry: PaddockGeometry | null }> }>(fetcher, scope, `/api/farming/farms/${encodeURIComponent(farm.id)}/paddocks`);
    if (!paddocks.body) continue;
    const shapes = paddocks.body.paddocks.filter((paddock) => paddock.status === "active" && paddock.geometry).map((paddock) => paddock.geometry!);
    areas.push({ farmId: farm.id, farmName: farm.name, box: farmArea(shapes) });
  }
  const plans = planDeviceTiles(areas);
  const wanted = new Map<string, TileId>();
  for (const plan of plans) for (const tile of plan.tiles) wanted.set(tileKey(tile), tile);

  running = { done: 0, total: wanted.size };
  changed();
  let problem: string | null = null;
  try {
    const cache = await cacheStorage.open(tileCacheName(scope));
    // What's kept already: sizes, and photos no longer in any farm's area (deleted).
    const kept = new Map<string, { bytes: number; savedAt: string | null }>();
    for (const request of await cache.keys()) {
      const match = /\/v1\/tiles\/aerial\/3857\/(\d+)\/(\d+)\/(\d+)\.webp$/.exec(request.url);
      if (!match) continue;
      const id = `${match[1]}/${match[2]}/${match[3]}`;
      if (!wanted.has(id)) {
        await cache.delete(request);
        continue;
      }
      const response = await cache.match(request);
      kept.set(id, { bytes: Number(response?.headers.get("x-tohyee-bytes") ?? "0"), savedAt: response?.headers.get("x-tohyee-saved-at") ?? null });
    }
    const maxAgeMs = (options.maxAgeDays ?? 90) * 86_400_000;
    let bytes = 0;
    for (const entry of kept.values()) bytes += entry.bytes;
    let done = 0;
    for (const [id, tile] of wanted) {
      const have = kept.get(id);
      const fresh = have && have.savedAt && now().getTime() - Date.parse(have.savedAt) < maxAgeMs;
      if (!fresh) {
        if (bytes >= OFFLINE_MAX_BYTES) {
          problem = "The space set aside for aerial photos on this device is full.";
          break;
        }
        let response: Response;
        try {
          response = await fetcher(linzAerialTileUrl(tile, key), { mode: "cors", credentials: "omit" });
        } catch {
          problem = "LINZ couldn't be reached, or didn't let this browser keep its photos.";
          break;
        }
        if (response.status === 401 || response.status === 403) {
          problem = "LINZ didn't accept the key. An admin can get a new one in Settings.";
          break;
        }
        if (response.ok) {
          const blob = await response.blob();
          const savedAt = now().toISOString();
          if (have) bytes -= have.bytes;
          bytes += blob.size;
          try {
            await cache.put(tileCacheUrl(tile), new Response(blob, { headers: { "content-type": response.headers.get("content-type") ?? "image/webp", "x-tohyee-saved-at": savedAt, "x-tohyee-bytes": String(blob.size) } }));
            kept.set(id, { bytes: blob.size, savedAt });
          } catch {
            problem = "This device ran out of space for aerial photos.";
            break;
          }
        }
        // Another status (e.g. no imagery there): skipped, tried again next time.
        if (options.spacingMs !== 0) await wait(options.spacingMs ?? 125);
      }
      done += 1;
      running = { done, total: wanted.size };
      options.onProgress?.(running);
      if (done % 25 === 0) changed();
    }
    const summary: TileSummary = {
      savedAt: now().toISOString(),
      farms: plans.map((plan) => ({ farmId: plan.farmId, farmName: plan.farmName, tiles: plan.tiles.filter((tile) => kept.has(tileKey(tile))).length, zooms: plan.plan.zooms, leftOut: plan.plan.leftOut })),
      tiles: kept.size,
      bytes,
      problem,
    };
    await cache.put(summaryUrl(scope), new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } }));
    return { outcome: "done", summary };
  } finally {
    running = null;
    changed();
  }
}

/** Whether this device keeps photos by itself: a phone or tablet, or Tohyee opened from a Home Screen icon (decision 1063). */
export function keepsPhotosByItself(userAgent: string, maxTouchPoints: number, installed: boolean): boolean {
  return installed || /iPhone|iPod|iPad|Android/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}
