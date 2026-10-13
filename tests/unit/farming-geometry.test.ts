import { describe, expect, it } from "vitest";
import { areaHectares, bounds, GeometryError, hectaresText, parseGeometry } from "@/lib/farming/geometry";

/** A box near Dunedin: 0.004° of latitude by 0.0065° of longitude. */
const box = (west = 170.5, south = -45.874, width = 0.0065, height = 0.004) => [
  [west, south],
  [west + width, south],
  [west + width, south + height],
  [west, south + height],
  [west, south],
];

describe("paddock shapes (#249 stage 1)", () => {
  it("works out a box's area geodesically: about 22.44 ha", () => {
    const geometry = parseGeometry({ type: "Polygon", coordinates: [box()] });
    // By hand: 444.8 m north-south × 504.1 m east-west ≈ 22.42 ha (a flat approximation).
    expect(areaHectares(geometry)).toBeCloseTo(22.437, 2);
    expect(hectaresText(areaHectares(geometry))).toBe("22.44");
  });

  it("takes holes off and adds the parts of a MultiPolygon", () => {
    const hole = box(170.502, -45.873, 0.001, 0.001).reverse();
    const withHole = parseGeometry({ type: "Polygon", coordinates: [box(), hole] });
    const holeArea = areaHectares(parseGeometry({ type: "Polygon", coordinates: [hole] }));
    expect(areaHectares(withHole)).toBeCloseTo(22.437 - holeArea, 3);
    const two = parseGeometry({ type: "MultiPolygon", coordinates: [[box()], [box(170.52)]] });
    expect(areaHectares(two)).toBeCloseTo(2 * 22.437, 1);
  });

  it("reads a Feature's geometry, and the area doesn't depend on which way round the points go", () => {
    const forward = parseGeometry({ type: "Feature", properties: { name: "12" }, geometry: { type: "Polygon", coordinates: [box()] } });
    const backward = parseGeometry({ type: "Polygon", coordinates: [box().reverse()] });
    expect(areaHectares(forward)).toBeCloseTo(areaHectares(backward), 6);
  });

  it("refuses shapes that aren't paddocks", () => {
    const refused = (value: unknown, message: string | RegExp) => expect(() => parseGeometry(value)).toThrow(message);
    refused({ type: "Point", coordinates: [170.5, -45.87] }, "A paddock is a Polygon or MultiPolygon, not Point.");
    refused({ type: "Polygon", coordinates: [box().slice(0, 4)] }, "isn't closed");
    refused({ type: "Polygon", coordinates: [[[170.5, -45.87], [170.51, -45.87], [170.5, -45.87]]] }, "needs at least three corners");
    // A bow tie: two edges cross.
    refused({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }, "crosses itself");
    // NZTM metres, not longitude and latitude.
    refused({ type: "Polygon", coordinates: [[[1406000, 4916000], [1406500, 4916000], [1406500, 4916500], [1406000, 4916000]]] }, /NZTM/);
    expect(() => parseGeometry(null)).toThrow(GeometryError);
  });

  it("finds the bounds of several shapes", () => {
    const shapes = [parseGeometry({ type: "Polygon", coordinates: [box()] }), parseGeometry({ type: "Polygon", coordinates: [box(170.52)] })];
    const [west, south, east, north] = bounds(shapes)!;
    expect([west, south, east, north].map((value) => Number(value.toFixed(6)))).toEqual([170.5, -45.874, 170.5265, -45.87]);
    expect(bounds([])).toBeNull();
  });
});
