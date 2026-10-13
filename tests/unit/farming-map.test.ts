import { describe, expect, it } from "vitest";
import { fromWorld, linzAerialTileUrl, mapView, mapViewAt, outlinesOverlap, parseGeometry, toWorld } from "@/lib/farming/geometry";

/** The usual "slippy map" tile numbers, written independently of mapView (OpenStreetMap wiki formula). */
function slippy(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n) };
}

describe("paddock map over aerial tiles (#249)", () => {
  it("puts 0,0 in the middle of the world and the south below the north", () => {
    expect(toWorld([0, 0])).toEqual([0.5, 0.5]);
    expect(toWorld([170.5, -45.87])[1]).toBeGreaterThan(toWorld([170.5, -45.0])[1]);
  });

  it("fits a farm into the drawing, inside the padding, north up", () => {
    const box: [number, number, number, number] = [170.5, -45.874, 170.5265, -45.86];
    const view = mapView(box, 800, 520);
    const [x1, y1] = view.project([170.5, -45.86]); // north-west corner
    const [x2, y2] = view.project([170.5265, -45.874]); // south-east corner
    for (const value of [x1, x2]) expect(value).toBeGreaterThanOrEqual(24 - 1e-6);
    for (const value of [x1, x2]) expect(value).toBeLessThanOrEqual(776 + 1e-6);
    for (const value of [y1, y2]) expect(value).toBeGreaterThanOrEqual(24 - 1e-6);
    for (const value of [y1, y2]) expect(value).toBeLessThanOrEqual(496 + 1e-6);
    expect(y1).toBeLessThan(y2);
    // One side touches the padding exactly: the fit is as large as it can be.
    expect(Math.min(x1, y1, 800 - x2, 520 - y2)).toBeCloseTo(24, 6);
  });

  it("lists the tiles that cover the drawing, numbered as XYZ tiles are", () => {
    const box: [number, number, number, number] = [170.5, -45.874, 170.5265, -45.86];
    const view = mapView(box, 800, 520);
    const z = view.tiles[0].z;
    expect(z).toBe(Math.ceil(view.zoom));
    // The tile under a paddock corner is the one the standard formula gives, and the corner falls inside it.
    const corner = slippy(170.51, -45.865, z);
    const tile = view.tiles.find((entry) => entry.x === corner.x && entry.y === corner.y)!;
    expect(tile).toBeDefined();
    const [px, py] = view.project([170.51, -45.865]);
    expect(px).toBeGreaterThanOrEqual(tile.left);
    expect(px).toBeLessThan(tile.left + tile.size);
    expect(py).toBeGreaterThanOrEqual(tile.top);
    expect(py).toBeLessThan(tile.top + tile.size);
    // Together the tiles cover the whole drawing.
    expect(Math.min(...view.tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.min(...view.tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...view.tiles.map((t) => t.left + t.size))).toBeGreaterThanOrEqual(800);
    expect(Math.max(...view.tiles.map((t) => t.top + t.size))).toBeGreaterThanOrEqual(520);
    expect(view.tiles.length).toBeLessThan(60);
  });

  it("doesn't zoom past the limits for a tiny shape", () => {
    const view = mapView([170.5, -45.87, 170.50001, -45.86999], 800, 520, { maxZoom: 19, maxTileZoom: 18 });
    expect(view.zoom).toBe(19);
    expect(view.tiles[0].z).toBe(18);
    expect(view.tiles[0].size).toBeCloseTo(512, 6);
  });

  it("builds LINZ's documented aerial tile address", () => {
    expect(linzAerialTileUrl({ z: 9, x: 502, y: 321 }, "abc_DEF-123")).toBe("https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/9/502/321.webp?api=abc_DEF-123");
  });

  it("turns a tap on the drawing back into longitude and latitude (for drawing paddocks)", () => {
    expect(fromWorld(toWorld([170.5, -45.87]))[0]).toBeCloseTo(170.5, 10);
    expect(fromWorld(toWorld([170.5, -45.87]))[1]).toBeCloseTo(-45.87, 10);
    const view = mapViewAt([170.5, -45.87], 16.3, 800, 520);
    expect(view.project([170.5, -45.87])).toEqual([400, 260]);
    for (const point of [[170.501, -45.871], [170.4995, -45.8693]] as Array<[number, number]>) {
      const [lon, lat] = view.unproject(view.project(point));
      expect(lon).toBeCloseTo(point[0], 10);
      expect(lat).toBeCloseTo(point[1], 10);
    }
  });

  it("spots a drawn paddock overlapping another, but not one sharing a fence line", () => {
    const box = (west: number, south: number, size: number) =>
      parseGeometry({ type: "Polygon", coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] });
    const twelve = box(170.5, -45.87, 0.004);
    expect(outlinesOverlap(twelve, box(170.502, -45.868, 0.004))).toBe(true); // edges cross
    expect(outlinesOverlap(twelve, box(170.501, -45.869, 0.001))).toBe(true); // wholly inside
    expect(outlinesOverlap(box(170.501, -45.869, 0.001), twelve)).toBe(true);
    expect(outlinesOverlap(twelve, box(170.5, -45.87, 0.004))).toBe(true); // drawn again on top
    expect(outlinesOverlap(twelve, box(170.504, -45.87, 0.004))).toBe(false); // shares the east fence
    expect(outlinesOverlap(twelve, box(170.51, -45.87, 0.004))).toBe(false); // apart
  });
});
