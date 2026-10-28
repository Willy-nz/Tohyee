import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { farmArea, keyAge, OFFLINE_MAX_TILES_PER_FARM, planDeviceTiles, planFarmTiles, TEST_TILE, tileAt, tileCacheUrl, tilesInBox } from "@/lib/farming/imagery";
import { checkImageryKey, clearFarmTiles, hash, keepFarmTiles, keepsPhotosByItself, readTileSummary, tileCacheName } from "@/lib/farming/imagery-device";

/*
 * Aerial photos (#485, decisions 1060-1066): the key's 80-day reminder,
 * the farm's area and its tiles, checking a key, keeping photos on a
 * device and the service worker's answer. Made-up keys only.
 */

const FAKE_KEY = "c01testkeyNOTREAL0000000000";

const square = (west: number, south: number, size: number): PaddockGeometry => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [west + size, south],
      [west + size, south + size],
      [west, south + size],
      [west, south],
    ],
  ],
});

describe("the key's age and reminder", () => {
  it("reminds from day 80 and says a standard key has run out from day 90", () => {
    expect(keyAge(null, "2026-10-29")).toBeNull();
    expect(keyAge("2026-08-01", "2026-10-19")).toMatchObject({ stage: "fine", remindOn: "2026-10-20", expiresOn: "2026-10-30", daysLeft: 11 });
    expect(keyAge("2026-08-01", "2026-10-20")).toMatchObject({ stage: "remind", daysLeft: 10 });
    expect(keyAge("2026-08-01", "2026-10-29")).toMatchObject({ stage: "remind", daysLeft: 1 });
    expect(keyAge("2026-08-01", "2026-10-30")).toMatchObject({ stage: "expired", daysLeft: 0 });
    expect(keyAge("2026-08-01", "2027-01-01")).toMatchObject({ stage: "expired", daysLeft: 0 });
  });

  it("counts across the end of a year and a leap day", () => {
    expect(keyAge("2027-12-15", "2028-03-04")).toMatchObject({ remindOn: "2028-03-04", expiresOn: "2028-03-14", stage: "remind" });
  });
});

describe("tiles", () => {
  it("numbers tiles as LINZ's Web Mercator XYZ tiles do", () => {
    expect(tileAt([-180, 85], 0)).toEqual({ z: 0, x: 0, y: 0 });
    expect(tileAt([174.7762, -41.2865], 8)).toEqual({ z: 8, x: 252, y: 160 });
    expect(TEST_TILE).toEqual({ z: 12, x: 4036, y: 2564 });
    expect(tileCacheUrl({ z: 18, x: 1, y: 2 })).toBe("https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/18/1/2.webp");
  });

  it("adds a 300 m margin around the paddocks", () => {
    const box = farmArea([square(169.9, -46.2, 0.01)])!;
    expect(box[1]).toBeCloseTo(-46.2 - 300 / 111_320, 6);
    expect(box[3]).toBeCloseTo(-46.19 + 300 / 111_320, 6);
    // A degree of longitude is shorter this far south, so the margin is more degrees wide.
    expect(169.9 - box[0]).toBeCloseTo(300 / (111_320 * Math.cos((-46.195 * Math.PI) / 180)), 6);
    expect(farmArea([])).toBeNull();
  });

  it("lists every tile in a box, rows north to south", () => {
    const tiles = tilesInBox([169.9, -46.21, 169.92, -46.19], 16);
    const xs = new Set(tiles.map((tile) => tile.x));
    const ys = new Set(tiles.map((tile) => tile.y));
    expect(tiles).toHaveLength(xs.size * ys.size);
    expect(tiles[0].y).toBe(Math.min(...ys));
  });

  it("keeps zooms 14 to 18 for a dairy farm, and drops close zooms first for a big station", () => {
    // About 200 ha: 1.4 km square.
    const dairy = planFarmTiles(farmArea([square(169.9, -46.2, 0.018)])!);
    expect(dairy.zooms).toEqual([14, 15, 16, 17, 18]);
    expect(dairy.leftOut).toEqual([]);
    expect(dairy.tiles.length).toBeLessThanOrEqual(OFFLINE_MAX_TILES_PER_FARM);
    expect(dairy.estimatedBytes).toBe(dairy.tiles.length * 25 * 1024);
    // A big station: about 14 km by 20 km.
    const station = planFarmTiles(farmArea([square(169.0, -45.2, 0.18)])!);
    expect(station.zooms).toEqual([14, 15]);
    expect(station.leftOut).toEqual([16, 17, 18]);
    expect(station.tiles.length).toBeLessThanOrEqual(OFFLINE_MAX_TILES_PER_FARM);
    // Nothing fits: nothing kept.
    expect(planFarmTiles(farmArea([square(169.0, -45.2, 0.18)])!, { maxTiles: 2 })).toMatchObject({ tiles: [], zooms: [], leftOut: [14, 15, 16, 17, 18] });
  });

  it("shares tiles between neighbouring farms and stops at the device's total", () => {
    const home = farmArea([square(169.9, -46.2, 0.01)]);
    const runoff = farmArea([square(169.905, -46.2, 0.01)]);
    const plans = planDeviceTiles([
      { farmId: "home", farmName: "Home", box: home },
      { farmId: "runoff", farmName: "Runoff", box: runoff },
      { farmId: "none", farmName: "No shapes", box: null },
    ]);
    expect(plans.map((plan) => plan.farmId)).toEqual(["home", "runoff"]);
    const limited = planDeviceTiles(
      [
        { farmId: "home", farmName: "Home", box: home },
        { farmId: "far", farmName: "Far away", box: farmArea([square(175, -39, 0.01)]) },
      ],
      plans[0].tiles.length + 5,
    );
    expect(limited[0].tiles.length).toBe(plans[0].tiles.length);
    expect(limited[1]).toMatchObject({ tiles: [], plan: { zooms: [] } });
  });
});

describe("checking a key in the browser", () => {
  const answer = (status: number) => (async () => new Response("x", { status })) as unknown as typeof fetch;

  it("loads the Wellington test photo with the key", async () => {
    let asked = "";
    const fetcher = (async (url: string) => {
      asked = url;
      return new Response("img", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkImageryKey(` ${FAKE_KEY} `, { fetcher, online: true })).toEqual({ ok: true });
    expect(asked).toBe(`https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/12/4036/2564.webp?api=${FAKE_KEY}`);
  });

  it("tells a refusal from no connection and from not knowing why", async () => {
    expect(await checkImageryKey(FAKE_KEY, { fetcher: answer(403), online: true })).toEqual({ ok: false, reason: "refused" });
    expect(await checkImageryKey(FAKE_KEY, { fetcher: answer(401), online: true })).toEqual({ ok: false, reason: "refused" });
    expect(await checkImageryKey(FAKE_KEY, { fetcher: answer(500), online: true })).toEqual({ ok: false, reason: "failed" });
    expect(await checkImageryKey(FAKE_KEY, { fetcher: answer(200), online: false })).toEqual({ ok: false, reason: "offline" });
  });

  it("falls back to loading it as an image when the browser can't read LINZ's answer", async () => {
    const blocked = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await checkImageryKey(FAKE_KEY, { fetcher: blocked, online: true, loadImage: async () => true })).toEqual({ ok: true });
    expect(await checkImageryKey(FAKE_KEY, { fetcher: blocked, online: true, loadImage: async () => false })).toEqual({ ok: false, reason: "failed" });
  });
});

/** A small Cache Storage, enough for these tests. */
function memoryCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const cacheFor = (name: string) => {
    const entries = stores.get(name)!;
    return {
      async match(request: string | Request) {
        const hit = entries.get(typeof request === "string" ? request : request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request: string, response: Response) {
        entries.set(request, response);
      },
      async delete(request: string | Request) {
        return entries.delete(typeof request === "string" ? request : request.url);
      },
      async keys() {
        return [...entries.keys()].map((url) => new Request(url));
      },
    };
  };
  const storage = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheFor(name);
    },
    async has(name: string) {
      return stores.has(name);
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async match() {
      return undefined;
    },
  };
  return { storage: storage as unknown as CacheStorage, stores };
}

function pretendTohyee(options: { key?: string | null; tileStatus?: number } = {}) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "basemaps.linz.govt.nz") {
      asked.push(url.pathname + url.search);
      return new Response(new Uint8Array(1000), { status: options.tileStatus ?? 200, headers: { "content-type": "image/webp" } });
    }
    if (url.pathname === "/api/farming/settings") return Response.json({ settings: { enabled: true, imageryKey: options.key === undefined ? FAKE_KEY : options.key, imageryKeySavedOn: "2026-10-01" } });
    if (url.pathname === "/api/farming/farms") return Response.json({ farms: [{ id: "f1", name: "Home block", isActive: true }] });
    if (url.pathname === "/api/farming/farms/f1/paddocks") return Response.json({ paddocks: [{ status: "active", geometry: square(169.9, -46.2, 0.003) }] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

const scope = { server: "https://farm.example.nz", userId: "user-1", organisationId: "org-1" };
const now = () => new Date("2026-10-29T08:00:00Z");

describe("keeping the farm's area on a device", () => {
  it("keeps each photo once, without the key in its address, with a summary", async () => {
    const { storage, stores } = memoryCaches();
    const tohyee = pretendTohyee();
    const result = await keepFarmTiles(scope, { fetcher: tohyee.fetcher, cacheStorage: storage, now, spacingMs: 0 });
    expect(result.outcome).toBe("done");
    const expected = planFarmTiles(farmArea([square(169.9, -46.2, 0.003)])!).tiles.length;
    expect(tohyee.asked).toHaveLength(expected);
    expect(tohyee.asked.every((asked) => asked.endsWith(`?api=${FAKE_KEY}`))).toBe(true);
    const kept = [...stores.get(tileCacheName(scope))!.keys()];
    expect(kept.some((url) => url.includes(FAKE_KEY))).toBe(false);
    expect(result.summary).toMatchObject({ tiles: expected, bytes: expected * 1000, problem: null, farms: [{ farmId: "f1", farmName: "Home block", zooms: [14, 15, 16, 17, 18] }] });
    expect(await readTileSummary(scope, storage)).toEqual(result.summary);

    // Within 12 hours: nothing fetched. Forced: only what's missing (nothing).
    expect((await keepFarmTiles(scope, { fetcher: tohyee.fetcher, cacheStorage: storage, now, spacingMs: 0 })).outcome).toBe("recent");
    await keepFarmTiles(scope, { fetcher: tohyee.fetcher, cacheStorage: storage, now, spacingMs: 0, force: true });
    expect(tohyee.asked).toHaveLength(expected);
  });

  it("stops at LINZ's first refusal and says so", async () => {
    const { storage } = memoryCaches();
    const tohyee = pretendTohyee({ tileStatus: 403 });
    const result = await keepFarmTiles(scope, { fetcher: tohyee.fetcher, cacheStorage: storage, now, spacingMs: 0 });
    expect(tohyee.asked).toHaveLength(1);
    expect(result.summary).toMatchObject({ tiles: 0, problem: expect.stringContaining("didn't accept the key") });
  });

  it("deletes the photos when the key is removed, and another account's on sign-in", async () => {
    const { storage, stores } = memoryCaches();
    await keepFarmTiles(scope, { fetcher: pretendTohyee().fetcher, cacheStorage: storage, now, spacingMs: 0 });
    const other = { ...scope, userId: "user-2" };
    await keepFarmTiles(other, { fetcher: pretendTohyee().fetcher, cacheStorage: storage, now, spacingMs: 0 });
    expect(stores.size).toBe(2);
    await clearFarmTiles(scope.server, "user-2", storage);
    expect([...stores.keys()]).toEqual([tileCacheName(other)]);
    expect((await keepFarmTiles(other, { fetcher: pretendTohyee({ key: null }).fetcher, cacheStorage: storage, now, spacingMs: 0, force: true })).outcome).toBe("no_key");
    expect(stores.size).toBe(0);
  });

  it("names caches the way the service worker looks for them", () => {
    expect(hash("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(tileCacheName(scope).startsWith(`tohyee-tiles-${hash(`${scope.server}|${scope.userId}`)}-`)).toBe(true);
  });

  it("keeps photos by itself only on phones, tablets and installed apps", () => {
    expect(keepsPhotosByItself("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5, false)).toBe(true);
    expect(keepsPhotosByItself("Mozilla/5.0 (Linux; Android 15)", 5, false)).toBe(true);
    expect(keepsPhotosByItself("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5, false)).toBe(true);
    expect(keepsPhotosByItself("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0, false)).toBe(false);
    expect(keepsPhotosByItself("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0, true)).toBe(true);
  });
});

type Tiles = {
  tileCacheUrl(href: string): string | null;
  accountPrefix(hash: (text: string) => string, origin: string, userId: string): string;
  handle(event: { request: { url: string }; respondWith(response: Promise<Response>): void }, readContext: () => Promise<unknown>, rules: unknown, cacheStorage: CacheStorage, origin: string): boolean;
};

function loadServiceWorkerTiles(fetchImpl: () => Promise<Response>) {
  const code = fs.readFileSync(path.join(import.meta.dirname, "../../public/sw-tiles.js"), "utf8");
  const sandbox: { self: { TohyeeTiles?: Tiles }; URL: typeof URL; Promise: typeof Promise; fetch: () => Promise<Response> } = { self: {}, URL, Promise, fetch: fetchImpl };
  vm.runInNewContext(code, sandbox);
  return sandbox.self.TohyeeTiles!;
}

describe("the service worker's aerial photos (public/sw-tiles.js)", () => {
  const rules = { hash, sessionState: (verifiedAt: string | null) => ({ open: Boolean(verifiedAt), expiresAt: null }) };

  it("only answers LINZ aerial photos, keyed without the key", () => {
    const tiles = loadServiceWorkerTiles(async () => new Response());
    expect(tiles.tileCacheUrl(`https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/16/63180/42000.webp?api=${FAKE_KEY}`)).toBe("https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/16/63180/42000.webp");
    expect(tiles.tileCacheUrl("https://basemaps.linz.govt.nz/v1/tiles/topographic/3857/16/1/2.webp")).toBeNull();
    expect(tiles.tileCacheUrl("https://example.com/v1/tiles/aerial/3857/16/1/2.webp")).toBeNull();
    expect(tiles.accountPrefix(hash, scope.server, scope.userId)).toBe(tileCacheName(scope).slice(0, tileCacheName(scope).lastIndexOf("-") + 1));
  });

  it("answers from the kept copy with no connection, only for the signed-in account within its offline session", async () => {
    const { storage } = memoryCaches();
    await keepFarmTiles(scope, { fetcher: pretendTohyee().fetcher, cacheStorage: storage, now, spacingMs: 0 });
    const tile = planFarmTiles(farmArea([square(169.9, -46.2, 0.003)])!).tiles[0];
    const url = `https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/${tile.z}/${tile.x}/${tile.y}.webp?api=${FAKE_KEY}`;
    const offline = loadServiceWorkerTiles(async () => {
      throw new TypeError("offline");
    });
    const ask = async (context: unknown) => {
      let answer: Promise<Response> | null = null;
      const handled = offline.handle({ request: { url }, respondWith: (response) => (answer = response) }, async () => context, rules, storage, scope.server);
      expect(handled).toBe(true);
      return answer!;
    };
    expect((await ask({ userId: "user-1", verifiedAt: "2026-10-28T00:00:00Z" })).headers.get("x-tohyee-bytes")).toBe("1000");
    await expect(ask({ userId: "user-2", verifiedAt: "2026-10-28T00:00:00Z" })).rejects.toThrow("offline");
    await expect(ask({ userId: "user-1", verifiedAt: null })).rejects.toThrow("offline");
  });
});
