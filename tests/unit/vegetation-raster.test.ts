import { describe, expect, it } from "vitest";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { decodePng, encodePng } from "@/lib/farming/vegetation/png";
import { bandsFromPicture } from "@/lib/farming/vegetation/provider";
import {
  type BandRaster,
  clearShare,
  farmGrid,
  fromMercator,
  type Grid,
  GridError,
  gridBox,
  ndviOf,
  ndviRaster,
  overlayPixels,
  paddockChange,
  paddockPixels,
  paddockStats,
  pixelOffset,
  toMercator,
} from "@/lib/farming/vegetation/raster";
import { CHANGE_SCALE, MISSING_COLOURS, NDVI_SCALE } from "@/lib/farming/vegetation/rules";

/*
 * Greenness maths on small hand-made rasters (#612, decisions 1524-1532).
 * The grid is 10 m pixels near the equator's origin so the numbers are easy
 * to follow: pixel (col, row) covers x = 10·col to 10·col+10 and
 * y = 100 − 10·row down to 90 − 10·row (Web Mercator metres).
 */

const GRID: Grid = { crs: "EPSG:3857", pixel: 10, minX: 0, maxY: 100, width: 10, height: 10 };
const THRESHOLDS = { minCoveragePct: 80, minValidPixels: 4 };

/** A rectangle in Web Mercator metres as a lon/lat paddock. */
function rect(x0: number, y0: number, x1: number, y1: number): PaddockGeometry {
  const ring = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ].map(([x, y]) => fromMercator([x, y]));
  return { type: "Polygon", coordinates: [ring] };
}

/** Bands with every pixel the same, then changed where `set` says. */
function bands(fill: { red: number; nir: number; scl: number }, set: Array<[number, number, Partial<{ red: number; nir: number; scl: number }>]> = []): BandRaster {
  const n = GRID.width * GRID.height;
  const raster: BandRaster = { width: GRID.width, height: GRID.height, red: new Uint16Array(n).fill(fill.red), nir: new Uint16Array(n).fill(fill.nir), scl: new Uint8Array(n).fill(fill.scl) };
  for (const [col, row, values] of set) {
    const i = row * GRID.width + col;
    if (values.red !== undefined) raster.red[i] = values.red;
    if (values.nir !== undefined) raster.nir[i] = values.nir;
    if (values.scl !== undefined) raster.scl[i] = values.scl;
  }
  return raster;
}

describe("NDVI from Sentinel-2 bands", () => {
  it("is (NIR − red) / (NIR + red) on reflectance; the 10000 scale divides out", () => {
    // Red 0.05, NIR 0.40 reflectance: (0.40 − 0.05) / 0.45 = 0.7778.
    expect(ndviOf(500, 4000)).toBeCloseTo(0.7778, 4);
    expect(ndviOf(1000, 1000)).toBe(0);
    expect(ndviOf(3000, 1000)).toBeCloseTo(-0.5, 4);
  });

  it("applies a baseline 04.00 offset before the ratio (it doesn't cancel)", () => {
    // Raw DN 1500 and 5000 with BOA_ADD_OFFSET −1000 are reflectance 0.05 and 0.40: the same 0.7778.
    expect(ndviOf(1500, 5000, -1000)).toBeCloseTo(0.7778, 4);
    // Without the offset the same numbers would read 0.5385: wrong, which is why it's passed.
    expect(ndviOf(1500, 5000)).toBeCloseTo(0.5385, 4);
  });

  it("is missing, never zero, for no data or values at or under the offset", () => {
    expect(ndviOf(0, 4000)).toBeNull();
    expect(ndviOf(500, 0)).toBeNull();
    expect(ndviOf(900, 4000, -1000)).toBeNull();
  });

  it("masks cloud, shadow, water, snow, unclassified and no data by scene class", () => {
    const raster = ndviRaster(
      bands({ red: 500, nir: 4000, scl: 4 }, [
        [1, 0, { scl: 5 }],
        [2, 0, { scl: 3 }],
        [3, 0, { scl: 6 }],
        [4, 0, { scl: 7 }],
        [5, 0, { scl: 8 }],
        [6, 0, { scl: 9 }],
        [7, 0, { scl: 10 }],
        [8, 0, { scl: 11 }],
        [9, 0, { scl: 0 }],
      ]),
    );
    const row = Array.from(raster.slice(0, 10)).map((value) => (Number.isNaN(value) ? null : Math.round(value * 10000) / 10000));
    expect(row).toEqual([0.7778, 0.7778, null, null, null, null, null, null, null, null]);
  });
});

describe("which pixels are a paddock's", () => {
  it("takes pixels whose centre is inside, and marks those touching the edge", () => {
    // 38 × 38 m: the centres of cols 2-5, rows 2-5 are inside; the outer 12 have a corner outside, the middle 4 don't.
    const { pixels, edge } = paddockPixels(GRID, rect(21, 41, 59, 79));
    expect(pixels.length).toBe(16);
    expect(Array.from(pixels).slice(0, 4)).toEqual([22, 23, 24, 25]);
    expect(edge.reduce((sum, value) => sum + value, 0)).toBe(12);
    // Shifted half a pixel, the pixel centres it takes move with it: spatial alignment.
    const shifted = paddockPixels(GRID, rect(26, 34, 66, 74));
    expect(shifted.pixels[0]).toBe(3 * 10 + 3);
  });

  it("gives a paddock narrower than a pixel no pixels at all", () => {
    expect(paddockPixels(GRID, rect(21, 20, 24, 80)).pixels.length).toBe(0);
  });
});

describe("a paddock's numbers", () => {
  const square = paddockPixels(GRID, rect(20, 40, 60, 80));

  it("mean and median of clear pixels, with the clear share", () => {
    const raster = ndviRaster(bands({ red: 500, nir: 4000, scl: 4 }, [[2, 2, { red: 1000, nir: 1000 }]]));
    const stats = paddockStats(raster, square, THRESHOLDS);
    expect(stats).toMatchObject({ totalPixels: 16, validPixels: 16, coveragePct: 100, quality: "good", medianNdvi: 0.7778 });
    expect(stats.meanNdvi).toBeCloseTo((15 * 0.7778 + 0) / 16, 3);
  });

  it("cloud over all of it is missing (null), not zero", () => {
    const stats = paddockStats(ndviRaster(bands({ red: 500, nir: 4000, scl: 9 })), square, THRESHOLDS);
    expect(stats).toMatchObject({ validPixels: 0, meanNdvi: null, medianNdvi: null, coveragePct: 0, quality: "no_data" });
  });

  it("cloud over half is too little to compare", () => {
    const cloud: Array<[number, number, { scl: number }]> = [];
    for (let row = 2; row <= 3; row += 1) for (let col = 2; col <= 5; col += 1) cloud.push([col, row, { scl: 9 }]);
    const stats = paddockStats(ndviRaster(bands({ red: 500, nir: 4000, scl: 4 }, cloud)), square, THRESHOLDS);
    expect(stats).toMatchObject({ validPixels: 8, coveragePct: 50, quality: "low_coverage", meanNdvi: 0.7778 });
  });

  it("a tiny or narrow paddock is flagged honestly", () => {
    const tiny = paddockStats(ndviRaster(bands({ red: 500, nir: 4000, scl: 4 })), paddockPixels(GRID, rect(20, 60, 40, 70)), THRESHOLDS);
    expect(tiny).toMatchObject({ totalPixels: 2, quality: "too_small" });
    expect(tiny.flags).toEqual(["small", "narrow_or_edge"]);
    const none = paddockStats(ndviRaster(bands({ red: 500, nir: 4000, scl: 4 })), paddockPixels(GRID, rect(21, 20, 24, 80)), THRESHOLDS);
    expect(none).toMatchObject({ totalPixels: 0, quality: "too_small", meanNdvi: null, coveragePct: null });
  });
});

describe("change between dates", () => {
  const square = paddockPixels(GRID, rect(20, 40, 60, 80));

  it("only over pixels clear on both dates", () => {
    const now = ndviRaster(bands({ red: 500, nir: 4000, scl: 4 }));
    // Earlier: NDVI 0.6 everywhere, but cloud over one pixel that's clear now; it's left out, not counted as change.
    const earlierBands = bands({ red: 1000, nir: 4000, scl: 4 }, [[2, 2, { scl: 9, red: 4000, nir: 500 }]]);
    const result = paddockChange({ grid: GRID, ndvi: now }, { grid: GRID, ndvi: ndviRaster(earlierBands) }, square, THRESHOLDS);
    expect(result.commonPixels).toBe(15);
    expect(result.change).toBeCloseTo(0.7778 - 0.6, 4);
  });

  it("can't compare when too little is clear on both", () => {
    const cloudy = ndviRaster(bands({ red: 500, nir: 4000, scl: 9 }));
    const clear = ndviRaster(bands({ red: 500, nir: 4000, scl: 4 }));
    expect(paddockChange({ grid: GRID, ndvi: clear }, { grid: GRID, ndvi: cloudy }, square, THRESHOLDS)).toEqual({ change: null, commonPixels: 0 });
  });

  it("lines up grids snapped to the same pixels, and refuses ones that don't", () => {
    expect(pixelOffset(GRID, { ...GRID, minX: -20, maxY: 110 })).toEqual({ dCol: 2, dRow: 1 });
    expect(pixelOffset(GRID, { ...GRID, minX: -25 })).toBeNull();
    expect(pixelOffset(GRID, { ...GRID, pixel: 14 })).toBeNull();
    // The same land in a bigger grid: change is still worked out pixel for pixel.
    const big: Grid = { ...GRID, minX: -20, maxY: 110, width: 12, height: 11 };
    const bigBands: BandRaster = { width: 12, height: 11, red: new Uint16Array(132).fill(1000), nir: new Uint16Array(132).fill(4000), scl: new Uint8Array(132).fill(4) };
    const result = paddockChange({ grid: GRID, ndvi: ndviRaster(bands({ red: 500, nir: 4000, scl: 4 })) }, { grid: big, ndvi: ndviRaster(bigBands) }, square, THRESHOLDS);
    expect(result.commonPixels).toBe(16);
    expect(result.change).toBeCloseTo(0.1778, 4);
  });
});

describe("the map pictures", () => {
  it("colours paddock pixels on the fixed scale, stripes missing ones grey, leaves the rest clear", () => {
    const square = paddockPixels(GRID, rect(20, 40, 60, 80));
    const inPaddock = new Uint8Array(100);
    for (const index of square.pixels) inPaddock[index] = 1;
    const raster = ndviRaster(bands({ red: 500, nir: 4000, scl: 4 }, [[3, 2, { scl: 9 }]]));
    const rgba = overlayPixels(GRID, raster, inPaddock);
    const at = (col: number, row: number) => Array.from(rgba.slice((row * 10 + col) * 4, (row * 10 + col) * 4 + 4));
    expect(at(2, 2)).toEqual([...NDVI_SCALE[5].colour, 230]);
    // Stripes two pixels wide: (3 + 2) % 4 is 1, the light grey.
    expect(at(3, 2)).toEqual([...MISSING_COLOURS.light, 230]);
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(clearShare(raster, inPaddock)).toBe(93.75);
    // Change: the same scale on every date (0.18 more green is "much more").
    const earlier = ndviRaster(bands({ red: 1000, nir: 4000, scl: 4 }));
    const change = overlayPixels(GRID, raster, inPaddock, { grid: GRID, ndvi: earlier });
    expect(Array.from(change.slice(22 * 4, 22 * 4 + 3))).toEqual(CHANGE_SCALE[4].colour);
  });
});

describe("a farm's grid", () => {
  it("is about 10 m on the ground, snapped to whole pixels, with a margin", () => {
    // A 400 m square paddock near Balclutha, at about 46° south.
    const [x, y] = toMercator([169.73, -46.24]);
    const geometry = rect(x, y, x + 577, y + 577);
    const grid = farmGrid([geometry]);
    expect(grid.pixel).toBe(14.5);
    expect(grid.minX % grid.pixel).toBeCloseTo(0, 6);
    expect(grid.maxY % grid.pixel).toBeCloseTo(0, 6);
    const [minX, minY, maxX, maxY] = gridBox(grid);
    expect(minX).toBeLessThanOrEqual(x - 50);
    expect(maxY).toBeGreaterThanOrEqual(y + 577 + 50);
    expect(maxX - minX).toBeCloseTo(grid.width * grid.pixel, 6);
    expect(maxY - minY).toBeCloseTo(grid.height * grid.pixel, 6);
  });

  it("refuses a farm too big for one picture", () => {
    const [x, y] = toMercator([169.73, -46.24]);
    expect(() => farmGrid([rect(x, y, x + 40_000, y + 40_000)])).toThrow(GridError);
  });
});

describe("PNG pictures", () => {
  it("writes and reads 8-bit and 16-bit RGBA exactly", () => {
    const eight = new Uint8Array([255, 0, 10, 230, 1, 2, 3, 4, 9, 8, 7, 6, 0, 0, 0, 0]);
    const decoded8 = decodePng(encodePng(2, 2, eight));
    expect(decoded8).toMatchObject({ width: 2, height: 2, channels: 4, bitDepth: 8 });
    expect(Array.from(decoded8.data)).toEqual(Array.from(eight));
    const sixteen = new Uint16Array([500, 4000, 4, 1, 65535, 0, 9, 1, 1000, 1000, 5, 1, 0, 0, 0, 0]);
    const decoded16 = decodePng(encodePng(2, 2, sixteen, 16));
    expect(Array.from(decoded16.data)).toEqual(Array.from(sixteen));
  });

  it("turns a provider picture into bands, the data mask clearing a pixel's class", () => {
    const grid: Grid = { ...GRID, width: 2, height: 1 };
    const png = encodePng(2, 1, new Uint16Array([500, 4000, 4, 1, 500, 4000, 4, 0]), 16);
    const raster = bandsFromPicture(png, grid);
    expect(Array.from(raster.scl)).toEqual([4, 0]);
    expect(Array.from(raster.nir)).toEqual([4000, 4000]);
    expect(() => bandsFromPicture(png, GRID)).toThrow("came back 2 × 1");
  });

  it("refuses things that aren't PNG pictures", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("isn't a PNG");
  });
});
