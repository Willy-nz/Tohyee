import { encodePng } from "@/lib/farming/vegetation/png";
import type { ProviderId, SceneCandidate, VegetationProvider } from "@/lib/farming/vegetation/provider";
import { type Grid } from "@/lib/farming/vegetation/raster";

/*
 * Made-up pictures (#612, decision 1522) for tests and the demo farm: the
 * same 16-bit bands a real provider sends, worked out from the place and the
 * date so the same request always gives the same picture. A pass every 5
 * days at 22:35 UTC (about 10:35 am in New Zealand); every sixth is cloudy
 * over the whole farm and some are half cloudy, with cloud shadow beside the
 * cloud. Greenness varies smoothly across the land, with the seasons and with
 * a slow made-up grazing round. None of it is real; the screens say so.
 */

const PASS_EVERY_DAYS = 5;
const EPOCH = Date.parse("2026-01-02T22:35:00Z");
const DAY = 86_400_000;

function hash(a: number, b: number, seed: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth noise 0-1 over Web Mercator metres, cells of `size` metres. */
function noise(x: number, y: number, size: number, seed: number): number {
  const gx = x / size;
  const gy = y / size;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0, seed) * (1 - sx) + hash(x0 + 1, y0, seed) * sx;
  const bottom = hash(x0, y0 + 1, seed) * (1 - sx) + hash(x0 + 1, y0 + 1, seed) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** Which pass a time is, and its kind of weather. */
function passKind(index: number): "clear" | "half" | "cloudy" {
  if (index % 6 === 2) return "cloudy";
  if (index % 4 === 1) return "half";
  return "clear";
}

/** The made-up greenness at a place and time. */
export function demoNdvi(x: number, y: number, at: number): number {
  const day = (at - EPOCH) / DAY;
  const dayOfYear = new Date(at).getUTCDate() + new Date(at).getUTCMonth() * 30.4;
  const base = 0.5 + 0.22 * (noise(x, y, 400, 1) - 0.5) + 0.12 * (noise(x, y, 90, 2) - 0.5);
  const season = 0.08 * Math.cos((2 * Math.PI * (dayOfYear - 300)) / 365);
  const grazing = 0.1 * Math.sin((2 * Math.PI * day) / 40 + noise(x, y, 600, 3) * 2 * Math.PI);
  return Math.max(0.05, Math.min(0.9, base + season + grazing));
}

export function createDemoProvider(): VegetationProvider {
  return {
    id: "demo" satisfies ProviderId,
    async checkConnection() {
      return { ok: true };
    },
    async search({ from, to }) {
      const start = Math.ceil((Date.parse(from) - EPOCH) / (PASS_EVERY_DAYS * DAY));
      const end = Math.floor((Date.parse(to) - EPOCH) / (PASS_EVERY_DAYS * DAY));
      const found: SceneCandidate[] = [];
      for (let index = Math.max(0, start); index <= end; index += 1) {
        const kind = passKind(index);
        const at = new Date(EPOCH + index * PASS_EVERY_DAYS * DAY).toISOString().replace(".000Z", "Z");
        found.push({
          acquiredAt: at,
          productIds: [`DEMO_MSIL2A_${at.slice(0, 10).replace(/-/g, "")}_N0511_T60GVA`],
          sceneCloudPct: kind === "cloudy" ? 72 : kind === "half" ? 38 : 4,
          processingBaseline: "05.11",
          platform: index % 2 ? "sentinel-2b" : "sentinel-2c",
        });
      }
      return found;
    },
    async fetch({ grid, candidate }) {
      return { png: demoPicture(grid, Date.parse(candidate.acquiredAt)), dnOffset: 0, unitsSpent: null, requests: 1 };
    },
  };
}

/** The 16-bit picture for a grid and time: red, near-infrared, scene class and data mask. */
export function demoPicture(grid: Grid, at: number): Uint8Array {
  const index = Math.round((at - EPOCH) / (PASS_EVERY_DAYS * DAY));
  const kind = passKind(index);
  const data = new Uint16Array(grid.width * grid.height * 4);
  const midX = grid.minX + (grid.width * grid.pixel) / 2;
  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const x = grid.minX + (col + 0.5) * grid.pixel;
      const y = grid.maxY - (row + 0.5) * grid.pixel;
      const ndvi = demoNdvi(x, y, at);
      const nir = Math.round(2600 + 1600 * ndvi);
      const red = Math.round((nir * (1 - ndvi)) / (1 + ndvi));
      let scl = ndvi > 0.35 ? 4 : 5;
      if (kind === "cloudy") scl = noise(x, y, 300, index) > 0.3 ? 9 : 8;
      else if (kind === "half") {
        // Cloud over the western half with a ragged edge; its shadow a little east of it.
        const edge = midX + (noise(x, y, 250, index) - 0.5) * 400;
        if (x < edge) scl = x < edge - 80 ? 9 : 8;
        else if (x < edge + 120) scl = 3;
      }
      data.set([red, nir, scl, 1], (row * grid.width + col) * 4);
    }
  }
  return encodePng(grid.width, grid.height, data, 16);
}
